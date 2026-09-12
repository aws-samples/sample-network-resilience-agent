import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';

// Stub the SDK command classes so we can drive the paginated responses.
// Parameter properties are banned by this project's `erasableSyntaxOnly`, so
// these stubs assign in the body.
vi.mock('@aws-sdk/client-ec2', () => {
  type Input = { NextToken?: string; nextToken?: string };
  class Base {
    input: Input;
    constructor(input: Input = {}) {
      this.input = input;
    }
  }
  class EC2Client {}
  class DescribeVpcsCommand extends Base {}
  class DescribeVpnGatewaysCommand extends Base {}
  class DescribeVpnConnectionsCommand extends Base {}
  class DescribeTransitGatewaysCommand extends Base {}
  class DescribeTransitGatewayAttachmentsCommand extends Base {}
  class DescribeTransitGatewayPeeringAttachmentsCommand extends Base {}
  class DescribeVpcPeeringConnectionsCommand extends Base {}
  class DescribeCustomerGatewaysCommand extends Base {}
  class DescribeTransitGatewayRouteTablesCommand extends Base {}
  class GetTransitGatewayRouteTablePropagationsCommand extends Base {}
  class SearchTransitGatewayRoutesCommand extends Base {}
  class DescribeRouteTablesCommand extends Base {}
  class DescribeRegionsCommand extends Base {}
  return {
    EC2Client,
    DescribeVpcsCommand,
    DescribeVpnGatewaysCommand,
    DescribeVpnConnectionsCommand,
    DescribeTransitGatewaysCommand,
    DescribeTransitGatewayAttachmentsCommand,
    DescribeTransitGatewayPeeringAttachmentsCommand,
    DescribeVpcPeeringConnectionsCommand,
    DescribeCustomerGatewaysCommand,
    DescribeTransitGatewayRouteTablesCommand,
    GetTransitGatewayRouteTablePropagationsCommand,
    SearchTransitGatewayRoutesCommand,
    DescribeRouteTablesCommand,
    DescribeRegionsCommand,
  };
});

const { DescribeRouteTablesCommand } = await import('@aws-sdk/client-ec2');
const { fetchVpcRouteTables, fetchTgwRouteTablePropagations } = await import('../ec2');

const sendMock = vi.fn();
const client = { send: sendMock } as unknown as EC2Client;

const EC2_MAX_PAGES = 1000;

beforeEach(() => {
  sendMock.mockReset();
});

function routeTable(id: string, vpcId = 'vpc-1') {
  return {
    RouteTableId: id,
    VpcId: vpcId,
    Associations: [{ Main: true }, { SubnetId: 'subnet-a' }],
    Tags: [{ Key: 'Name', Value: id }],
    Routes: [
      { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' },
      { DestinationCidrBlock: '0.0.0.0/0', TransitGatewayId: 'tgw-1', State: 'blackhole' },
    ],
  };
}

describe('fetchVpcRouteTables pagination', () => {
  it('follows NextToken across pages and maps every route table', async () => {
    sendMock.mockImplementation((cmd: { input: { NextToken?: string } }) =>
      cmd.input.NextToken
        ? Promise.resolve({ RouteTables: [routeTable('rtb-3')] })
        : Promise.resolve({ RouteTables: [routeTable('rtb-1'), routeTable('rtb-2')], NextToken: 'p2' }),
    );

    const out = await fetchVpcRouteTables(client);

    expect(out.map((rt) => rt.routeTableId)).toEqual(['rtb-1', 'rtb-2', 'rtb-3']);
    expect(out[0].isMain).toBe(true);
    expect(out[0].associatedSubnetIds).toEqual(['subnet-a']);
    expect(out[0].tags).toEqual({ Name: 'rtb-1' });
    expect(out[0].routes.map((r) => r.state)).toEqual(['active', 'blackhole']);
  });

  // EC2 uses PascalCase NextToken in both directions; DX uses lowercase. Getting
  // the case wrong silently restarts pagination from page 1 forever.
  it('sends the token back as PascalCase NextToken', async () => {
    sendMock.mockImplementation((cmd: { input: { NextToken?: string } }) =>
      cmd.input.NextToken
        ? Promise.resolve({ RouteTables: [] })
        : Promise.resolve({ RouteTables: [], NextToken: 'p2' }),
    );

    await fetchVpcRouteTables(client);

    const second = sendMock.mock.calls[1][0];
    expect(second).toBeInstanceOf(DescribeRouteTablesCommand);
    expect(second.input.NextToken).toBe('p2');
  });

  it('throws at the page cap instead of looping forever when NextToken never clears', async () => {
    sendMock.mockResolvedValue({ RouteTables: [routeTable('rtb-x')], NextToken: 'again' });

    await expect(fetchVpcRouteTables(client)).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(EC2_MAX_PAGES);
  });
});

// Added after the first bounded-paginator sweep, so it had reintroduced the
// unbounded loop. It is called once per TGW route table, so a runaway token
// multiplies across every route table on the account.
describe('fetchTgwRouteTablePropagations pagination', () => {
  const prop = (attachmentId: string) => ({
    TransitGatewayAttachmentId: attachmentId,
    ResourceId: 'vpc-1',
    ResourceType: 'vpc',
    State: 'enabled',
  });

  it('follows NextToken across pages', async () => {
    sendMock.mockImplementation((cmd: { input: { NextToken?: string } }) =>
      cmd.input.NextToken
        ? Promise.resolve({ TransitGatewayRouteTablePropagations: [prop('tgw-attach-2')] })
        : Promise.resolve({
            TransitGatewayRouteTablePropagations: [prop('tgw-attach-1')],
            NextToken: 'p2',
          }),
    );

    const out = await fetchTgwRouteTablePropagations(client, 'tgw-rtb-1');

    expect(out.map((p) => p.transitGatewayAttachmentId)).toEqual([
      'tgw-attach-1',
      'tgw-attach-2',
    ]);
    expect(out[0].state).toBe('enabled');
  });

  it('throws at the page cap when NextToken never clears', async () => {
    sendMock.mockResolvedValue({
      TransitGatewayRouteTablePropagations: [prop('tgw-attach-x')],
      NextToken: 'again',
    });

    await expect(fetchTgwRouteTablePropagations(client, 'tgw-rtb-1')).rejects.toThrow(
      /safety cap/,
    );
    expect(sendMock).toHaveBeenCalledTimes(EC2_MAX_PAGES);
  });
});

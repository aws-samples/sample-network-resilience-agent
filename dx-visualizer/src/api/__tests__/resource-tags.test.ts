import { describe, expect, it, vi } from 'vitest';
import { fetchConnections, fetchDxGateways, fetchLags, fetchVirtualInterfaces } from '../direct-connect';
import { fetchTransitGatewayAttachments } from '../ec2';
import { fetchCoreNetworks } from '../cloud-wan';
import { tagsToRecord } from '../../utils/aws-tags';

describe('resource tag collection', () => {
  const dxTags = [{ key: 'Environment', value: 'prod' }, { key: 'Empty', value: '' }];
  const expected = { Environment: 'prod', Empty: '' };

  it('retains tags from each Direct Connect inventory response without extra API calls', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ connections: [{ connectionId: 'dxcon-a', tags: dxTags }] })
      .mockResolvedValueOnce({ virtualInterfaces: [{ virtualInterfaceId: 'dxvif-a', tags: dxTags }] })
      .mockResolvedValueOnce({ directConnectGateways: [{ directConnectGatewayId: 'dxgw-a', tags: dxTags }] })
      .mockResolvedValueOnce({ lags: [{ lagId: 'dxlag-a', tags: dxTags, connections: [{ connectionId: 'dxcon-a', tags: dxTags }] }] });
    const client = { send } as never;
    expect((await fetchConnections(client))[0].tags).toEqual(expected);
    expect((await fetchVirtualInterfaces(client))[0].tags).toEqual(expected);
    expect((await fetchDxGateways(client))[0].tags).toEqual(expected);
    const [lag] = await fetchLags(client);
    expect(lag.tags).toEqual(expected);
    expect(lag.connections[0].tags).toEqual(expected);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('retains all TGW attachment tags in addition to the existing display name', async () => {
    const send = vi.fn().mockResolvedValue({
      TransitGatewayAttachments: [{ TransitGatewayAttachmentId: 'tgw-attach-a', Tags: [{ Key: 'Name', Value: 'SD-WAN' }, { Key: 'Environment', Value: 'prod' }] }],
    });
    const [attachment] = await fetchTransitGatewayAttachments({ send } as never);
    expect(attachment.name).toBe('SD-WAN');
    expect(attachment.tags).toEqual({ Name: 'SD-WAN', Environment: 'prod' });
  });

  it('retains Cloud WAN core network tags', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ CoreNetworks: [{ CoreNetworkId: 'core-network-a' }] })
      .mockResolvedValueOnce({ CoreNetwork: { CoreNetworkId: 'core-network-a', Tags: [{ Key: 'Environment', Value: 'prod' }] } });
    expect((await fetchCoreNetworks({ send } as never))[0].tags).toEqual({ Environment: 'prod' });
  });

  it('normalizes missing tags and preserves special keys as own properties', () => {
    expect(tagsToRecord(undefined)).toEqual({});
    const tags = tagsToRecord([{ Key: '__proto__', Value: 'value' }, { key: 'Empty' }, { value: 'no key' }]);
    expect(Object.hasOwn(tags, '__proto__')).toBe(true);
    expect(tags.__proto__).toBe('value');
    expect(tags.Empty).toBe('');
  });
});

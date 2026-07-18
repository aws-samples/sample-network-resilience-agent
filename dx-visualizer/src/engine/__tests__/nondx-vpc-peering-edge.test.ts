import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { makeEmptyTopology } from './helpers';

// Reproduces the customer report: a TGW with no DX Gateway association (off the
// DX path) has VPC attachments that are hidden by default behind the region
// "Show non DXGW association nodes" toggle. But those VPCs are ALSO endpoints of
// VPC peering connections, so the peering renderer puts them on the canvas
// anyway. Before the fix, the VPC rendered with only a peering edge and no line
// to its TGW — a visible, genuinely-attached VPC that looked unattached.
function makeNonDxTgwWithPeeredVpcs() {
  const topo = makeEmptyTopology();
  topo.homeAccountId = '111122223333';

  // DX presence exists elsewhere (a DXGW), so the "focus on DX" suppression is
  // active — mirrors the real snapshot where a DXGW existed but these TGWs
  // weren't associated to it.
  topo.dxGateways = [
    { directConnectGatewayId: 'dxgw-001', directConnectGatewayName: 'DXGW-Prod', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];

  topo.transitGateways = [
    {
      transitGatewayId: 'tgw-nondx',
      transitGatewayArn: 'arn:aws:ec2:eu-central-1:111122223333:transit-gateway/tgw-nondx',
      state: 'available',
      ownerId: '111122223333',
      description: 'Non-DX TGW',
      amazonSideAsn: 64512,
      tags: { Name: 'TGW-A' },
    },
    {
      transitGatewayId: 'tgw-peer',
      transitGatewayArn: 'arn:aws:ec2:eu-central-1:111122223333:transit-gateway/tgw-peer',
      state: 'available',
      ownerId: '111122223333',
      description: 'Peer TGW',
      amazonSideAsn: 64513,
      tags: { Name: 'TGW-B' },
    },
  ];

  // A TGW-to-TGW peering anchors TGW-A on the canvas (a non-VPC anchor) even
  // though it has no DX Gateway association — exactly like the real account,
  // where the peering is what keeps the TGW rendered while its VPC edges are
  // suppressed by the region toggle.
  topo.transitGatewayPeeringAttachments = [
    {
      transitGatewayAttachmentId: 'tgw-attach-peer',
      requesterTgwInfo: { transitGatewayId: 'tgw-nondx', region: 'eu-central-1', ownerId: '111122223333' },
      accepterTgwInfo: { transitGatewayId: 'tgw-peer', region: 'eu-central-1', ownerId: '111122223333' },
      state: 'available',
      tags: { Name: 'tgwA-tgwB-peer' },
    },
  ];

  // Two VPCs attached to the non-DX TGW.
  topo.vpcs = [
    { vpcId: 'vpc-a1', cidrBlock: '10.0.0.0/16', region: 'eu-central-1', ownerAccountId: '111122223333', tags: { Name: 'vpc-a1' }, state: 'available' },
    { vpcId: 'vpc-a2', cidrBlock: '10.1.0.0/16', region: 'eu-central-1', ownerAccountId: '111122223333', tags: { Name: 'vpc-a2' }, state: 'available' },
    // A spoke VPC peered to both a1 and a2 (like vpc-sa in the real account).
    { vpcId: 'vpc-sa', cidrBlock: '10.10.0.0/16', region: 'eu-central-1', ownerAccountId: '111122223333', tags: { Name: 'vpc-sa' }, state: 'available' },
  ];

  topo.transitGatewayAttachments = [
    { transitGatewayAttachmentId: 'tgw-attach-a1', transitGatewayId: 'tgw-nondx', resourceType: 'vpc', resourceId: 'vpc-a1', resourceOwnerId: '111122223333', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-a2', transitGatewayId: 'tgw-nondx', resourceType: 'vpc', resourceId: 'vpc-a2', resourceOwnerId: '111122223333', state: 'available' },
  ];

  // vpc-sa peers with both a1 and a2 — this is what pulls a1/a2 onto the canvas
  // even when the region toggle would otherwise hide them.
  topo.vpcPeerings = [
    {
      vpcPeeringConnectionId: 'pcx-sa-a1', state: 'active',
      requesterVpc: { vpcId: 'vpc-sa', cidrBlock: '10.10.0.0/16', ownerId: '111122223333', region: 'eu-central-1' },
      accepterVpc: { vpcId: 'vpc-a1', cidrBlock: '10.0.0.0/16', ownerId: '111122223333', region: 'eu-central-1' },
      tags: { Name: 'pcx-sa-a1' },
    },
    {
      vpcPeeringConnectionId: 'pcx-sa-a2', state: 'active',
      requesterVpc: { vpcId: 'vpc-sa', cidrBlock: '10.10.0.0/16', ownerId: '111122223333', region: 'eu-central-1' },
      accepterVpc: { vpcId: 'vpc-a2', cidrBlock: '10.1.0.0/16', ownerId: '111122223333', region: 'eu-central-1' },
      tags: { Name: 'pcx-sa-a2' },
    },
  ];

  return topo;
}

const tgwNodeId = 'tgw-tgw-nondx';

describe('non-DX TGW→VPC edges when the VPC is a rendered peering endpoint', () => {
  it('restores the TGW→VPC attachment edge for peered VPCs even with the region toggle off', () => {
    const topo = makeNonDxTgwWithPeeredVpcs();
    // showNonDxVpcs is empty → toggle off, matching the exported snapshot.
    const { nodes, edges } = buildGraph(topo, new Set());

    // The peered VPCs are on the canvas (pulled in by the VPC-peering renderer).
    expect(nodes.find((n) => n.id === 'vpc-vpc-a1')).toBeDefined();
    expect(nodes.find((n) => n.id === 'vpc-vpc-a2')).toBeDefined();
    // The TGW is on the canvas.
    expect(nodes.find((n) => n.id === tgwNodeId)).toBeDefined();

    // And crucially, the TGW→VPC attachment edges are drawn.
    const a1Edge = edges.find((e) => (e.source === tgwNodeId && e.target === 'vpc-vpc-a1') || (e.source === 'vpc-vpc-a1' && e.target === tgwNodeId));
    const a2Edge = edges.find((e) => (e.source === tgwNodeId && e.target === 'vpc-vpc-a2') || (e.source === 'vpc-vpc-a2' && e.target === tgwNodeId));
    expect(a1Edge).toBeDefined();
    expect(a2Edge).toBeDefined();
  });

  it('does not double-draw the attachment edge when the toggle is on', () => {
    const topo = makeNonDxTgwWithPeeredVpcs();
    const { edges } = buildGraph(topo, new Set(), new Set(), new Map(), new Set(), new Map(), new Set(['eu-central-1']));

    const a1Edges = edges.filter((e) => (e.source === tgwNodeId && e.target === 'vpc-vpc-a1') || (e.source === 'vpc-vpc-a1' && e.target === tgwNodeId));
    expect(a1Edges.length).toBe(1);
  });

  it('keeps the "non DXGW" count truthful — restored VPCs are not counted as hidden', () => {
    const topo = makeNonDxTgwWithPeeredVpcs();
    const { nodes } = buildGraph(topo, new Set());
    const regionNode = nodes.find((n) => n.id === 'region-eu-central-1');
    // Both attached VPCs are visible+wired, so none remain hidden → badge = 0
    // (which suppresses the toggle entirely in the region header).
    expect(regionNode?.data.nonDxVpcCount ?? 0).toBe(0);
  });

  it('still hides the attachment edge when the VPC is NOT otherwise on the canvas', () => {
    const topo = makeNonDxTgwWithPeeredVpcs();
    // Drop the peerings so a1/a2 have no other reason to render.
    topo.vpcPeerings = [];
    const { nodes, edges } = buildGraph(topo, new Set());

    // With the toggle off and no peering, the non-DX VPCs stay hidden.
    expect(nodes.find((n) => n.id === 'vpc-vpc-a1')).toBeUndefined();
    const a1Edge = edges.find((e) => e.target === 'vpc-vpc-a1' || e.source === 'vpc-vpc-a1');
    expect(a1Edge).toBeUndefined();
    // And the region badge reports them as hidden.
    const regionNode = nodes.find((n) => n.id === 'region-eu-central-1');
    expect(regionNode?.data.nonDxVpcCount).toBe(2);
  });
});

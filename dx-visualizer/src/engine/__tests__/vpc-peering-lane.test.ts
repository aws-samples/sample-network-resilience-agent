import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { applyLayout } from '../layout-engine';
import { makeEmptyTopology } from './helpers';
import {
  NODE_DIMENSIONS,
  PEERING_INTRA_OFFSET,
  PEERING_LABEL_HALF,
  PEERING_CROSS_CLEARANCE,
} from '../../utils/constants';
import type { DxNode } from '../../types/topology';

// Regression for the customer report (live account, Frankfurt): VPC↔VPC peering
// edges + their "VPC Peering pcx-…" labels rendered OUTSIDE the region and AWS
// containers because both boxes are sized from node bounding boxes only and never
// accounted for the smoothstep peering leg that bows out past the rightmost VPC.
//
// Rule: an intra-region peering must stay inside its region zone (the region
// widens by PEERING_INTRA_LANE); a cross-region peering routes outside the region
// but must still land inside the AWS zone (AWS widens by PEERING_CROSS_LANE).

// Absolute (canvas-space) rect of a node, walking the parentId chain since
// child nodes are positioned relative to their region / AWS parent.
function absRect(byId: Map<string, DxNode>, id: string) {
  const n = byId.get(id)!;
  let x = n.position.x;
  let y = n.position.y;
  let p = (n as unknown as { parentId?: string }).parentId;
  while (p) {
    const pn = byId.get(p)!;
    x += pn.position.x;
    y += pn.position.y;
    p = (pn as unknown as { parentId?: string }).parentId;
  }
  const isContainer = n.data.category === 'region' || n.data.category === 'awsCloud';
  const dim = NODE_DIMENSIONS[n.data.category] ?? { width: 0, height: 0 };
  return {
    x,
    y,
    w: isContainer ? (n.width as number) : dim.width,
    h: isContainer ? (n.height as number) : dim.height,
  };
}

function baseTwoRegionTopo() {
  const topo = makeEmptyTopology();
  topo.homeAccountId = '111122223333';
  topo.dxGateways = [
    { directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'DXGW', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];
  topo.transitGateways = [
    { transitGatewayId: 'tgw-sg', transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:111122223333:transit-gateway/tgw-sg', state: 'available', ownerId: '111122223333', description: '', amazonSideAsn: 64512, tags: { Name: 'SG-TGW' } },
    { transitGatewayId: 'tgw-us', transitGatewayArn: 'arn:aws:ec2:us-east-1:111122223333:transit-gateway/tgw-us', state: 'available', ownerId: '111122223333', description: '', amazonSideAsn: 64513, tags: { Name: 'US-TGW' } },
  ];
  // Two TGWs on one DX gateway, so the allowed prefixes have to be disjoint —
  // AWS rejects overlapping allowed prefixes across multiple TGW associations on
  // the same DX gateway. Each list covers only the VPCs behind its own TGW.
  topo.dxGatewayAssociations = [
    { directConnectGatewayId: 'dxgw-1', associatedGateway: { id: 'tgw-sg', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '111122223333' }, associationState: 'associated', allowedPrefixes: ['10.0.0.0/16', '10.1.0.0/16'] },
    { directConnectGatewayId: 'dxgw-1', associatedGateway: { id: 'tgw-us', type: 'transitGateway', region: 'us-east-1', ownerAccount: '111122223333' }, associationState: 'associated', allowedPrefixes: ['10.2.0.0/16'] },
  ];
  topo.vpcs = [
    { vpcId: 'vpc-sg1', cidrBlock: '10.0.0.0/16', region: 'ap-southeast-1', ownerAccountId: '111122223333', tags: { Name: 'sg-vpc-1' }, state: 'available' },
    { vpcId: 'vpc-sg2', cidrBlock: '10.1.0.0/16', region: 'ap-southeast-1', ownerAccountId: '111122223333', tags: { Name: 'sg-vpc-2' }, state: 'available' },
    { vpcId: 'vpc-us', cidrBlock: '10.2.0.0/16', region: 'us-east-1', ownerAccountId: '111122223333', tags: { Name: 'us-vpc' }, state: 'available' },
  ];
  topo.transitGatewayAttachments = [
    { transitGatewayAttachmentId: 'a1', transitGatewayId: 'tgw-sg', resourceType: 'vpc', resourceId: 'vpc-sg1', resourceOwnerId: '111122223333', state: 'available' },
    { transitGatewayAttachmentId: 'a2', transitGatewayId: 'tgw-sg', resourceType: 'vpc', resourceId: 'vpc-sg2', resourceOwnerId: '111122223333', state: 'available' },
    { transitGatewayAttachmentId: 'a3', transitGatewayId: 'tgw-us', resourceType: 'vpc', resourceId: 'vpc-us', resourceOwnerId: '111122223333', state: 'available' },
  ];
  return topo;
}

describe('VPC peering edge scope tagging', () => {
  it('tags same-region peering as intra and different-region as cross', () => {
    const topo = baseTwoRegionTopo();
    topo.vpcPeerings = [
      {
        vpcPeeringConnectionId: 'pcx-intra', state: 'active',
        requesterVpc: { vpcId: 'vpc-sg1', cidrBlock: '10.0.0.0/16', ownerId: '111122223333', region: 'ap-southeast-1' },
        accepterVpc: { vpcId: 'vpc-sg2', cidrBlock: '10.1.0.0/16', ownerId: '111122223333', region: 'ap-southeast-1' },
        tags: { Name: 'intra' },
      },
      {
        vpcPeeringConnectionId: 'pcx-cross', state: 'active',
        requesterVpc: { vpcId: 'vpc-sg1', cidrBlock: '10.0.0.0/16', ownerId: '111122223333', region: 'ap-southeast-1' },
        accepterVpc: { vpcId: 'vpc-us', cidrBlock: '10.2.0.0/16', ownerId: '111122223333', region: 'us-east-1' },
        tags: { Name: 'cross' },
      },
    ];
    const { edges } = buildGraph(topo, new Set());
    const intra = edges.find((e) => e.id === 'e-vpcpeer-pcx-intra');
    const cross = edges.find((e) => e.id === 'e-vpcpeer-pcx-cross');
    expect(intra?.data?.peeringScope).toBe('intra');
    expect(cross?.data?.peeringScope).toBe('cross');
  });
});

describe('VPC peering lane reservation keeps edges inside their box', () => {
  it('intra-region peering: leg + label stay inside the region (and thus AWS)', () => {
    const topo = baseTwoRegionTopo();
    topo.vpcPeerings = [
      {
        vpcPeeringConnectionId: 'pcx-intra', state: 'active',
        requesterVpc: { vpcId: 'vpc-sg1', cidrBlock: '10.0.0.0/16', ownerId: '111122223333', region: 'ap-southeast-1' },
        accepterVpc: { vpcId: 'vpc-sg2', cidrBlock: '10.1.0.0/16', ownerId: '111122223333', region: 'ap-southeast-1' },
        tags: { Name: 'intra' },
      },
    ];
    const { nodes, edges } = buildGraph(topo, new Set());
    const laid = applyLayout(nodes, edges);
    const byId = new Map(laid.map((n) => [n.id, n]));

    const region = laid.find((n) => n.data.category === 'region' && (n.data.details as Record<string, string>)?.regionCode === 'ap-southeast-1')!;
    const rr = absRect(byId, region.id);
    const regionRight = rr.x + rr.w;

    const src = absRect(byId, 'vpc-vpc-sg1');
    const tgt = absRect(byId, 'vpc-vpc-sg2');
    const vpcRight = Math.max(src.x + src.w, tgt.x + tgt.w);

    // CustomEdge routes the intra leg at a FIXED offset from the VPC right edge.
    const legX = vpcRight + PEERING_INTRA_OFFSET;
    const labelRight = legX + PEERING_LABEL_HALF;

    // Both endpoints are inside this region.
    expect(src.x).toBeGreaterThanOrEqual(rr.x);
    expect(tgt.x).toBeGreaterThanOrEqual(rr.x);
    // And the peering leg + label are enclosed by the (widened) region box.
    expect(labelRight).toBeLessThanOrEqual(regionRight);
  });

  it('cross-region peering: leg routes outside the region but label stays inside AWS', () => {
    const topo = baseTwoRegionTopo();
    topo.vpcPeerings = [
      {
        vpcPeeringConnectionId: 'pcx-cross', state: 'active',
        requesterVpc: { vpcId: 'vpc-sg1', cidrBlock: '10.0.0.0/16', ownerId: '111122223333', region: 'ap-southeast-1' },
        accepterVpc: { vpcId: 'vpc-us', cidrBlock: '10.2.0.0/16', ownerId: '111122223333', region: 'us-east-1' },
        tags: { Name: 'cross' },
      },
    ];
    const { nodes, edges } = buildGraph(topo, new Set());
    const laid = applyLayout(nodes, edges);
    const byId = new Map(laid.map((n) => [n.id, n]));

    const aws = laid.find((n) => n.data.category === 'awsCloud')!;
    const ar = absRect(byId, aws.id);
    const awsRight = ar.x + ar.w;

    const regions = laid.filter((n) => n.data.category === 'region');
    const maxRegionRight = Math.max(...regions.map((rn) => { const r = absRect(byId, rn.id); return r.x + r.w; }));

    const src = absRect(byId, 'vpc-vpc-sg1');
    const tgt = absRect(byId, 'vpc-vpc-us');
    const vpcRight = Math.max(src.x + src.w, tgt.x + tgt.w);

    // CustomEdge's region-clearing scan grows the offset until the leg sits
    // CLEARANCE past the widest crossed region.
    const legX = vpcRight + Math.max(120, maxRegionRight - vpcRight + PEERING_CROSS_CLEARANCE);
    const labelRight = legX + PEERING_LABEL_HALF;

    // Leg is outside every region box …
    expect(legX).toBeGreaterThan(maxRegionRight);
    // … but the leg + label are still enclosed by the (widened) AWS box.
    expect(labelRight).toBeLessThanOrEqual(awsRight);
  });
});

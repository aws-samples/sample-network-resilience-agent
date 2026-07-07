import { describe, it, expect } from 'vitest';
import { analyzeTopology } from '../recommendation-engine';
import { groupDxGatewaysBySharedDownstream } from '../downstream-grouping';
import { makeEmptyTopology } from './helpers';
import { multiDxgwTopology, multiDxgwSharedVpcTopology } from './fixtures/multi-dxgw-topology';
import type { TopologyData } from '../../types/topology';

/**
 * MULTI-DXGW SHARED-DOWNSTREAM RULE
 * =================================
 *
 * Two or more DX Gateways that serve the SAME downstream (the same TGW / VGW /
 * VPC via a shared TGW/VGW, or the same Cloud WAN core network) form a single
 * redundant group. The group ALREADY provides cross-DXGW redundancy, so we must
 * not demand a full 4 upstream links (2 locations × 2 devices) on each gateway
 * independently.
 *
 * Concretely: a DXGW's resilient posture is judged over the COMBINED scope of
 * every gateway in its shared-downstream group. When the combined scope already
 * meets the target tier (e.g. two single-location gateways at DIFFERENT sites
 * jointly span 2 locations → High), the per-DXGW second-location / second-
 * connection recommendations are suppressed for each member.
 *
 * DXGWs are grouped transitively: if A and B share TGW-1 and B and C share
 * TGW-2, then {A, B, C} is one group.
 */

function dxgw(id: string, name = id) {
  return { directConnectGatewayId: id, directConnectGatewayName: name, amazonSideAsn: 64512, directConnectGatewayState: 'available' };
}
function tgwAssoc(dxgwId: string, tgwId: string) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: tgwId, type: 'transitGateway' as const, region: 'ap-southeast-1', ownerAccount: '111122223333' },
    associationState: 'associated',
    allowedPrefixes: [],
  };
}
function vgwAssoc(dxgwId: string, vgwId: string) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: vgwId, type: 'virtualPrivateGateway' as const, region: 'ap-southeast-1', ownerAccount: '111122223333' },
    associationState: 'associated',
    allowedPrefixes: [],
  };
}
function coreAssoc(dxgwId: string, coreId: string) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: '', type: undefined, region: 'ap-southeast-1', ownerAccount: '111122223333' },
    associatedCoreNetwork: { id: coreId, ownerAccount: '111122223333', attachmentId: 'attach-1' },
    associationState: 'associated',
    allowedPrefixes: [],
  };
}

/** One private VIF for `dxgwId` on a fresh connection at `loc` / `device`. */
function vifAt(topo: TopologyData, dxgwId: string, loc: string, device: string, n: number) {
  const connId = `c-${dxgwId}-${n}`;
  topo.connections.push({ connectionId: connId, connectionName: connId, connectionState: 'available', location: loc, bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: device });
  topo.virtualInterfaces.push({ virtualInterfaceId: `v-${dxgwId}-${n}`, virtualInterfaceName: `v-${dxgwId}-${n}`, virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: connId, directConnectGatewayId: dxgwId, vlan: n, asn: 1, bgpPeers: [], region: 'ap-southeast-1', location: loc });
}

function loc(code: string) {
  return { locationCode: code, locationName: code, region: 'ap-southeast-1', availablePortSpeeds: [] };
}

function siteLocationRecIds(assessment: ReturnType<typeof analyzeTopology>, dxgwId: string): string[] {
  const g = assessment.perDxGateway.find((d) => d.dxGatewayId === dxgwId);
  return (g?.recommendations ?? []).filter((r) => r.ruleId === 'single-dx-location').map((r) => r.id);
}

// ===========================================================================
// groupDxGatewaysBySharedDownstream
// ===========================================================================
describe('groupDxGatewaysBySharedDownstream', () => {
  it('groups two DXGWs that share a TGW', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-1')];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA', 'gwB']));
    expect(groups.get('gwB')).toEqual(new Set(['gwA', 'gwB']));
  });

  it('keeps DXGWs with distinct downstreams in separate groups', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-2')];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA']));
    expect(groups.get('gwB')).toEqual(new Set(['gwB']));
  });

  it('groups transitively across shared targets (A-B share tgw1, B-C share tgw2)', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB'), dxgw('gwC')];
    t.dxGatewayAssociations = [
      tgwAssoc('gwA', 'tgw-1'),
      tgwAssoc('gwB', 'tgw-1'),
      tgwAssoc('gwB', 'tgw-2'),
      tgwAssoc('gwC', 'tgw-2'),
    ];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA', 'gwB', 'gwC']));
    expect(groups.get('gwC')).toEqual(new Set(['gwA', 'gwB', 'gwC']));
  });

  it('groups DXGWs sharing a VGW and DXGWs sharing a Cloud WAN core network', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB'), dxgw('gwC'), dxgw('gwD')];
    t.dxGatewayAssociations = [
      vgwAssoc('gwA', 'vgw-1'), vgwAssoc('gwB', 'vgw-1'),
      coreAssoc('gwC', 'core-1'), coreAssoc('gwD', 'core-1'),
    ];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA', 'gwB']));
    expect(groups.get('gwC')).toEqual(new Set(['gwC', 'gwD']));
  });

  it('a DXGW with no associations is its own singleton group', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwB')).toEqual(new Set(['gwB']));
  });

  // --- Deeper convergence: the shared TERMINAL VPC is what matters, since the
  // VPC holds the real workload. Two DXGWs whose DIFFERENT intermediate gateways
  // both reach the SAME VPC are one redundant group.
  it('groups two DXGWs whose different TGWs both attach to the SAME VPC', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-2')];
    // Both TGWs attach to vpc-shared.
    t.transitGatewayAttachments = [
      { transitGatewayAttachmentId: 'a1', transitGatewayId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-shared', resourceOwnerId: '1', state: 'available' },
      { transitGatewayAttachmentId: 'a2', transitGatewayId: 'tgw-2', resourceType: 'vpc', resourceId: 'vpc-shared', resourceOwnerId: '1', state: 'available' },
    ];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA', 'gwB']));
    expect(groups.get('gwB')).toEqual(new Set(['gwA', 'gwB']));
  });

  it('groups two DXGWs whose different VGWs both attach to the SAME VPC', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [vgwAssoc('gwA', 'vgw-1'), vgwAssoc('gwB', 'vgw-2')];
    t.vpnGateways = [
      { vpnGatewayId: 'vgw-1', vpcAttachments: [{ vpcId: 'vpc-shared', state: 'attached' }], type: 'ipsec.1', amazonSideAsn: 64512, state: 'available', tags: {} },
      { vpnGatewayId: 'vgw-2', vpcAttachments: [{ vpcId: 'vpc-shared', state: 'attached' }], type: 'ipsec.1', amazonSideAsn: 64513, state: 'available', tags: {} },
    ];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA', 'gwB']));
  });

  it('keeps DXGWs separate when their TGWs attach to DIFFERENT VPCs', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-2')];
    t.transitGatewayAttachments = [
      { transitGatewayAttachmentId: 'a1', transitGatewayId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-prod', resourceOwnerId: '1', state: 'available' },
      { transitGatewayAttachmentId: 'a2', transitGatewayId: 'tgw-2', resourceType: 'vpc', resourceId: 'vpc-corp', resourceOwnerId: '1', state: 'available' },
    ];
    const groups = groupDxGatewaysBySharedDownstream(t);
    expect(groups.get('gwA')).toEqual(new Set(['gwA']));
    expect(groups.get('gwB')).toEqual(new Set(['gwB']));
  });
});

// ===========================================================================
// analyzeTopology — shared-downstream suppresses redundant per-DXGW recs
// ===========================================================================
describe('shared-downstream posture in analyzeTopology', () => {
  it('two single-location DXGWs at DIFFERENT sites sharing a TGW: no second-location rec', () => {
    const t = makeEmptyTopology();
    t.locations = [loc('LocA'), loc('LocB')];
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1', 1);
    vifAt(t, 'gwB', 'LocB', 'devB1', 1);

    const a = analyzeTopology(t, 'high');
    // The pair jointly spans 2 locations → High already met via cross-DXGW
    // redundancy; neither gateway should be told to add a second location.
    expect(siteLocationRecIds(a, 'gwA')).toEqual([]);
    expect(siteLocationRecIds(a, 'gwB')).toEqual([]);
  });

  it('two single-location DXGWs at the SAME site sharing a TGW: still recommend a second location', () => {
    const t = makeEmptyTopology();
    t.locations = [loc('LocA')];
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1', 1);
    vifAt(t, 'gwB', 'LocA', 'devA1', 2);

    const a = analyzeTopology(t, 'high');
    // Combined scope is still a single location → site failure kills both →
    // the second-location rec must still fire (at least for one member).
    const total = siteLocationRecIds(a, 'gwA').length + siteLocationRecIds(a, 'gwB').length;
    expect(total).toBeGreaterThan(0);
  });

  it('two single-location DXGWs with DIFFERENT downstreams each still get a second-location rec', () => {
    const t = makeEmptyTopology();
    t.locations = [loc('LocA'), loc('LocB')];
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-2')];
    vifAt(t, 'gwA', 'LocA', 'devA1', 1);
    vifAt(t, 'gwB', 'LocB', 'devB1', 1);

    const a = analyzeTopology(t, 'high');
    // Independent downstreams → each gateway is judged on its own single-location
    // posture → both still get the second-location rec.
    expect(siteLocationRecIds(a, 'gwA').length).toBeGreaterThan(0);
    expect(siteLocationRecIds(a, 'gwB').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Mock scenarios — multiDxgw (distinct VPCs) vs multiDxgwSharedVpc (converged)
// ===========================================================================
describe('multiDxgw mock scenarios', () => {
  it('distinct-VPC variant keeps the two DXGWs in SEPARATE groups', () => {
    const groups = groupDxGatewaysBySharedDownstream(multiDxgwTopology);
    expect(groups.get('dxgw-mdx-prod')).toEqual(new Set(['dxgw-mdx-prod']));
    expect(groups.get('dxgw-mdx-corp')).toEqual(new Set(['dxgw-mdx-corp']));
  });

  it('shared-VPC variant GROUPS the two DXGWs (both TGWs attach the same VPC)', () => {
    const groups = groupDxGatewaysBySharedDownstream(multiDxgwSharedVpcTopology);
    expect(groups.get('dxgw-mdx-prod')).toEqual(new Set(['dxgw-mdx-prod', 'dxgw-mdx-corp']));
    expect(groups.get('dxgw-mdx-corp')).toEqual(new Set(['dxgw-mdx-prod', 'dxgw-mdx-corp']));
  });
});

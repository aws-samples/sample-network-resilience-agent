// Re-export shared constants for convenient access
export { REGION_NAMES, RESILIENCY_TIERS, WELCOME_MESSAGE, type MockScenario } from './shared';

export const LAYOUT = {
  vpcCollapseThreshold: 4,
  tgwCollapseThreshold: 3,
  partnerCollapseThreshold: 3,
};

// --- VPC peering lane geometry (shared by layout-engine + CustomEdge) ---
// VPC↔VPC peering edges exit the VPC's right handle and bow out into a vertical
// "lane" to the right of the VPC column, with the pcx label centered on that leg.
// Because containers are sized from node bounding boxes only, the lane must be
// reserved explicitly or the edge + label escape the region / AWS boxes.
//
// Intra-region peerings stay INSIDE their region: CustomEdge uses this fixed
// offset (never the region-clearing scan), and layout-engine widens the region's
// right edge by PEERING_INTRA_LANE so the leg + label are enclosed. The offset is
// a constant so the region can reserve exactly the right width with no feedback
// loop (a scan-derived offset would chase the widening region outward forever).
export const PEERING_INTRA_OFFSET = 90; // fixed leg offset from the VPC right edge
// Half the widest a centered peering label can be (CustomEdge caps peering labels
// at maxWidth 180 → half 90; +6 margin). Used to enclose the label, not just the leg.
export const PEERING_LABEL_HALF = 96;
// Breathing room between a CROSS-region peering's vertical leg and the region box
// it routes past. MUST match the CLEARANCE used in CustomEdge's region-clearing
// scan so the layout engine reserves exactly the space the edge renderer uses.
export const PEERING_CROSS_CLEARANCE = 64;
// Reserved width added to a region's right side when it holds an intra-region
// peering: leg offset + label half + a little margin.
export const PEERING_INTRA_LANE = PEERING_INTRA_OFFSET + PEERING_LABEL_HALF + 4;
// Reserved width added to the AWS Cloud's right side, beyond the rightmost
// region, when a CROSS-region peering exists: those legs route just past the
// widest region (clearance) and their label must still fall inside AWS.
export const PEERING_CROSS_LANE = PEERING_CROSS_CLEARANCE + PEERING_LABEL_HALF + 20;

// Intrinsic node dimensions used by the layout engine to compute positions dynamically.
// These must approximate the ACTUAL rendered size of each node type (including icon, label,
// subtitle, badges, and padding). If a node overflows its container, increase its dimensions here.
export const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  onPremise: { width: 200, height: 80 },
  cgw: { width: 260, height: 80 },
  dxPartnerDevice: { width: 170, height: 75 },
  dxPartnerDeviceGroup: { width: 170, height: 90 },
  lag: { width: 180, height: 95 },
  awsDevice: { width: 170, height: 75 },
  dxGateway: { width: 180, height: 80 },
  tgw: { width: 170, height: 105 },
  tgwConnect: { width: 180, height: 70 },
  vgw: { width: 200, height: 75 },
  vpc: { width: 200, height: 85 },
  vpcGroup: { width: 130, height: 90 },
  tgwGroup: { width: 170, height: 90 },
  isolatedTgwGroup: { width: 170, height: 95 },
  coreNetwork: { width: 260, height: 85 },
  publicResources: { width: 220, height: 130 },
};

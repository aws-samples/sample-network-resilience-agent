// Re-export shared constants for convenient access
export { REGION_NAMES, RESILIENCY_TIERS, WELCOME_MESSAGE, type MockScenario } from './shared';

export const LAYOUT = {
  vpcCollapseThreshold: 4,
  tgwCollapseThreshold: 3,
  partnerCollapseThreshold: 3,
};

// --- Hover-path dimming (shared by every off-path element) ---
// Hovering a node/edge label highlights its whole E2E path and fades everything
// else. These live here because the fade is applied in six places (BaseNode, the
// four collapsed-group cards, and CustomEdge's stroke + flow dot + label) and the
// off-path set has to read as ONE receding layer — when the values drifted apart
// the canvas looked like two different amounts of "off".
//
// Per-element values are deliberately different, because equal alpha does not
// read as equal prominence: a 2px stroke and its animated dot disappear into the
// background at an opacity that leaves a filled card clearly legible, and the
// dot is the most eye-catching thing out there since it moves.
//
// Light theme cannot go as far as dark. An off-path card there is near-white on a
// near-white canvas, so past roughly 0.18 it stops being faint context and simply
// vanishes — which loses the surrounding topology the highlight is meant to be
// read against. Dark theme has the room, so it takes it.
export const HOVER_DIM = {
  node: { dark: 0.12, light: 0.18 },
  edge: { dark: 0.06, light: 0.12 },
  edgeDot: { dark: 0.06, light: 0.12 },
  edgeLabel: { dark: 0.1, light: 0.16 },
} as const;

/** Off-path opacity for one element kind in the active theme. */
export function dimOpacityFor(kind: keyof typeof HOVER_DIM, light: boolean): number {
  return light ? HOVER_DIM[kind].light : HOVER_DIM[kind].dark;
}

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

// --- VPC-group table geometry (single source of truth) ---
// A collapsed VPC group can render as a scrollable table (view mode "table").
// The layout engine reserves the node's height from these SAME constants the
// VpcGroupNode component renders with, so the region container hugs the table
// with no empty gap and no scroll overflow — change them here, both sides move
// together (mirrors the PEERING_* "MUST match the renderer" pattern above).
export const VPC_TABLE_WIDTH = 300;
export const VPC_TABLE_HEADER_HEIGHT = 70; // title row + Expand/Collapse + column header
export const VPC_TABLE_ROW_HEIGHT = 24; // one VPC row
// The scroll body is capped here; beyond it the table scrolls internally. Both
// the component's max-height and the layout's reserved height derive from this,
// so they can never drift.
export const VPC_TABLE_MAX_BODY_HEIGHT = 400;

/** Reserved/rendered height of a VPC group table: header + capped, scrollable body. */
export function vpcTableHeight(rowCount: number): number {
  return VPC_TABLE_HEADER_HEIGHT + Math.min(rowCount * VPC_TABLE_ROW_HEIGHT, VPC_TABLE_MAX_BODY_HEIGHT);
}

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
  tgwFirewall: { width: 200, height: 85 },
  vgw: { width: 200, height: 75 },
  vpc: { width: 200, height: 85 },
  vpcGroup: { width: 130, height: 90 },
  tgwGroup: { width: 170, height: 90 },
  isolatedTgwGroup: { width: 170, height: 95 },
  coreNetwork: { width: 260, height: 85 },
  publicResources: { width: 220, height: 130 },
};

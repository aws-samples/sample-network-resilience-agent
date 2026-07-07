// Re-export shared constants for convenient access
export { REGION_NAMES, RESILIENCY_TIERS, WELCOME_MESSAGE, type MockScenario } from './shared';

export const LAYOUT = {
  vpcCollapseThreshold: 4,
  tgwCollapseThreshold: 3,
  partnerCollapseThreshold: 3,
};

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

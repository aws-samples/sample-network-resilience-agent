import type { DxNode, DxEdge } from './topology';

export type ResiliencyLevel = 'none' | 'devtest' | 'high' | 'maximum';

export interface Recommendation {
  id: string;
  ruleId: string;
  category: 'resiliency' | 'bestpractice';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  additionalNodes: DxNode[];
  additionalEdges: DxEdge[];
}

export interface ResiliencyAssessment {
  currentLevel: ResiliencyLevel;
  targetLevel: ResiliencyLevel;
  recommendations: Recommendation[];
}

export interface BestPracticeAssessment {
  annotations: NodeAnnotation[];
  recommendations: Recommendation[];
}

export interface NodeAnnotation {
  nodeId: string;
  badge: {
    type: 'warning' | 'info' | 'error';
    label: string;
    description: string;
  };
}

export interface DxGatewayAssessment {
  dxGatewayId: string;
  dxGatewayName: string;
  currentLevel: ResiliencyLevel;
  targetLevel: ResiliencyLevel;
  locationCount: number;
  connectionCount: number;
  /** True when the DXGW has no VIFs — resiliency tiering does not apply. */
  isUnattached?: boolean;
  /** True when at least one Virtual Interface points at this DXGW. */
  hasVif?: boolean;
  /** True when the DXGW has at least one TGW/VGW association. */
  hasAssociation?: boolean;
  /** Recommendations scoped to this DX Gateway (resiliency + best-practice). */
  recommendations: Recommendation[];
  /**
   * Resiliency recommendations minted at this gateway's OWN target — i.e. the
   * user's raw pick BEFORE any shared-carrier escalation to a co-riding public
   * VIF's higher tier. Used by getRecommendedGraph when this specific gateway is
   * focused so the canvas reflects exactly the tier its card shows. `recommendations`
   * stays escalated for the aggregated "view all" render. Undefined when it would
   * equal `recommendations` (raw target === effective target).
   */
  focusRecommendations?: Recommendation[];
}

export interface GlobalAssessment {
  resiliency: ResiliencyAssessment;
  bestPractice: BestPracticeAssessment;
}

/**
 * Per-VGW resilience card. A Virtual Private Gateway reached over Direct Connect
 * (a private VIF terminates on it) has the SAME site/device redundancy posture as
 * a DX Gateway — the DX path feeding it is what we make redundant. Only DX-reached
 * VGWs get an assessment; VPN-only VGWs have no DX path and keep the VPN/CGW
 * best-practice handling instead.
 */
export interface VgwAssessment {
  /** Virtual Private Gateway id (raw, e.g. `vgw-0abc...`). Node id is `vgw-<id>`. */
  vgwId: string;
  vgwName: string;
  currentLevel: ResiliencyLevel;
  targetLevel: ResiliencyLevel;
  locationCount: number;
  connectionCount: number;
  /** Recommendations scoped to this VGW's Direct Connect path. */
  recommendations: Recommendation[];
}

export interface PublicVifAssessment {
  currentLevel: ResiliencyLevel;
  targetLevel: ResiliencyLevel;
  locationCount: number;
  connectionCount: number;
  recommendations: Recommendation[];
  /**
   * Recommendations minted at the public VIF's OWN target, including any carrier
   * (DXGW/LAG) ghost paths re-minted at that same tier. Used by getRecommendedGraph
   * when the Public VIF row is focused so the canvas reflects the public tier —
   * not a carrier that a separately-focused DXGW pushed to a higher tier.
   * Undefined when it would equal `recommendations`.
   */
  focusRecommendations?: Recommendation[];
}

export interface LagAssessment {
  currentLevel: ResiliencyLevel;
  targetLevel: ResiliencyLevel;
  locationCount: number;
  lagCount: number;
  recommendations: Recommendation[];
  /** LAG recommendations minted at the LAG's own target (pre public-VIF escalation). */
  focusRecommendations?: Recommendation[];
}

export interface CombinedAssessment {
  /**
   * True when the account has zero DX footprint (no connections, VIFs, or DX
   * gateways) — DX resiliency tiers are not applicable. `resiliency.currentLevel`
   * stays 'none' for back-compat. Mirrors the per-DXGW isUnattached precedent.
   */
  dxNotInUse: boolean;
  /** Per-DXGW resilience cards. Empty when topology has no DX Gateways. */
  perDxGateway: DxGatewayAssessment[];
  /** Per-VGW resilience cards for VGWs reached over Direct Connect. Empty when none. */
  perVgw: VgwAssessment[];
  /** Public VIF resiliency assessment. Null when no standalone public VIFs exist. */
  publicVif: PublicVifAssessment | null;
  /** LAG resiliency assessment. Null when no LAGs exist. */
  lag: LagAssessment | null;
  /** Topology-wide rules that don't pin to a specific DX Gateway. */
  global: GlobalAssessment;
  /** Aggregated view of all resiliency recommendations (per-DXGW + global) for back-compat. */
  resiliency: ResiliencyAssessment;
  /** Aggregated view of all best-practice recommendations (per-DXGW + global) for back-compat. */
  bestPractice: BestPracticeAssessment;
}

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
  /**
   * Set when this gateway sits at one DX location on its own, but shares a
   * downstream (TGW / VGW / core network / terminal VPC) with other gateways
   * that reach it from other locations — so the engine suppresses the
   * "add a second location" rec and draws no ghost for it. The card names the
   * peers so its per-gateway tier doesn't contradict the empty canvas.
   * `currentLevel` is still this gateway's own posture.
   */
  siteRedundancyVia?: {
    /** Other gateways in the group that bring a DX location this one lacks. */
    peers: { dxGatewayId: string; dxGatewayName: string; locations: string[] }[];
    /** What is shared: named TGW/VGW/core network, or a VPC reached two ways. */
    sharedDownstream: string[];
  };
  /**
   * Set when this gateway carries transit VIFs into one or more DX-reached
   * Transit Gateways. Its tier is then stated on each TGW card (see `perTgw`),
   * not here: the TGW is the thing that must stay reachable, and a sibling
   * gateway feeding the same TGW changes the answer. `currentLevel` is still
   * computed, because the gateway's own ghost recommendations are minted from it.
   * Absent for private-VIF gateways, which keep their own tier.
   */
  assessedAtTgwIds?: string[];
}

/**
 * Per-TGW resilience card for a Transit Gateway reached over Direct Connect
 * through transit VIFs. Graded over the UNION of every transit VIF that reaches
 * it, across all the DX gateways associated to it — the TGW survives a site or
 * device failure if any of those paths does.
 *
 * Recommendations are text-only (no ghost nodes). The ghost paths that fix a gap
 * are minted by the feeding gateways' own rules, which already account for
 * siblings sharing this TGW; minting them here too would draw every path twice.
 */
export interface TgwAssessment {
  /** Transit Gateway id (raw, e.g. `tgw-0abc...`). */
  tgwId: string;
  /** `Name` tag when this account can describe the TGW, else the id. */
  tgwName: string;
  /** From the DX gateway association — the TGW may be in another region or account. */
  region?: string;
  ownerAccount?: string;
  currentLevel: ResiliencyLevel;
  targetLevel: ResiliencyLevel;
  locationCount: number;
  connectionCount: number;
  transitVifCount: number;
  /** DX gateways whose transit VIFs reach this TGW, in `dxGateways` order. */
  dxGatewayIds: string[];
  recommendations: Recommendation[];
  /**
   * Ghost device paths for this TGW's Maximum pick, graded over the TGW's own
   * scope. Drawn in place of the feeders' device-gap ghosts when the TGW card is
   * focused. Undefined when the target is not Maximum or a feeder rides a LAG.
   */
  deviceGapRecommendations?: Recommendation[];
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
  /**
   * Per-TGW resilience cards for Transit Gateways reached over transit VIFs.
   * Empty when none. Their recommendations are NOT folded into the aggregated
   * `resiliency` view — each restates, at TGW scope, a gap the feeding gateways'
   * own recommendations already carry (with the ghost paths), so aggregating
   * both would list every gap twice.
   */
  perTgw: TgwAssessment[];
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

import type { DxNode, DxEdge } from '../types/topology';
import { makeGhostNode, makeGhostEdge } from './ghost-helpers';
import type { ResiliencyTarget } from './resiliency-rules';

/**
 * A sink is a real (or already-emitted) node that a ghost AWS device fans out to
 * — a DX Gateway (`dxgw-<id>`, label "VIF") or the single consolidated public
 * endpoints node (`pub-endpoints`, label "Public VIF"). Modelling sinks as a
 * list lets one ghost device serve multiple upstreams: the resilient second
 * location added for a DXGW *also* carries the public VIF that rides the same
 * physical connection, so we draw one device with two edges rather than a
 * duplicate `rec-pubvif-*` chain.
 */
export interface GhostSink {
  nodeId: string;
  label: string;
}

const SINK_LABEL_POSITION = 0.2;

/** One ghost edge from `awsDevId` to each sink, labelled per sink. */
export function ghostSinkEdges(awsDevId: string, sinks: GhostSink[]): DxEdge[] {
  return sinks.map((s) => makeGhostEdge(awsDevId, s.nodeId, s.label, SINK_LABEL_POSITION));
}

/**
 * The partner → LAG → awsDevice edge pair for a recommended LAG. A ghost LAG has
 * no individual member connections to name, so — unlike a real LAG's per-member
 * fan (topology-builder) — the customer-side is drawn as ONE edge labelled
 * "N DX Connections" summarising the bundle, plus one "LAG Bundle · N
 * connections" edge into the AWS device. Callers pass the neighbouring real
 * LAG's member count so the ghost mirrors its size; anything under 2 is clamped
 * to 2 (a LAG is at least two connections).
 */
export function ghostLagEdges(partnerId: string, lagId: string, awsId: string, memberCount: number): DxEdge[] {
  const count = Math.max(2, memberCount);
  return [
    makeGhostEdge(partnerId, lagId, `${count} DX Connections`),
    makeGhostEdge(lagId, awsId, `LAG Bundle\n${count} connections`),
  ];
}

export interface SecondLocationOptions {
  /** ID prefix for all minted nodes/edges (e.g. `rec`, `rec-<dxgwId>`, `rec-pubvif`). */
  prefix: string;
  /** Synthetic location code linking the ghost location/partner/device nodes. */
  locCode: string;
  /** Upstreams each ghost AWS device connects to. */
  sinks: GhostSink[];
  /** `high` → one device at the new site; `maximum` → a redundant pair. */
  target: ResiliencyTarget;
  /** Overrides the DX location node label (defaults to "Second Direct Connect Location"). */
  siteLabel?: string;
  /** Extra details merged onto the DX location node (e.g. `{ dxGatewayId }`). */
  siteDetails?: Record<string, unknown>;
  /**
   * When set, REUSE this existing DX location instead of minting a ghost one.
   * The ghost partner+device chain attaches to the existing `dxloc-<code>`
   * container (its `locationCode` becomes this code) and no ghost `dxLocation`
   * node is emitted. Most topologies already have enough DX locations with AWS
   * devices to link into, so reuse is preferred over inventing a new site.
   */
  reuseLocationCode?: string;
}

/**
 * A ghost "second DX location" chain. The recommendation path STARTS at the
 * Customer / Partner Device (Customer Gateway) and flows inward toward AWS — it
 * deliberately does NOT mint a customer data center or on-prem router ghost,
 * since those aren't what AWS is recommending (the actionable fix is the DX-side
 * redundancy). Consists of one (high) or two (maximum) partner+AWS-device pairs,
 * each fanning out to every sink.
 *
 * Location handling (reuse-existing-first): when `reuseLocationCode` is set the
 * ghost devices attach to that EXISTING DX location (no ghost location minted).
 * Otherwise a ghost DX location container is minted and `siteLabel` /
 * `siteDetails` attach to it so topologies with multiple DXGWs keep
 * distinguishable ghost zones.
 */
export function secondLocationGhostChain(opts: SecondLocationOptions): {
  nodes: DxNode[];
  edges: DxEdge[];
} {
  const { prefix, locCode, sinks, target, siteLabel, siteDetails, reuseLocationCode } = opts;

  // Reuse attaches ghost devices to the existing location's container; a minted
  // location uses the synthetic `locCode`.
  const deviceLocCode = reuseLocationCode ?? locCode;

  const nodes: DxNode[] = [];
  if (!reuseLocationCode) {
    nodes.push(
      makeGhostNode(`${prefix}-dxloc-B`, 'dxLocation', siteLabel ?? 'Second Direct Connect Location', {
        details: { code: locCode, ...(siteDetails ?? {}) },
      }),
    );
  }
  nodes.push(
    makeGhostNode(`${prefix}-partner-B`, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: deviceLocCode } }),
    makeGhostNode(`${prefix}-awsdev-B`, 'awsDevice', 'AWS Device', { details: { locationCode: deviceLocCode } }),
  );

  const edges: DxEdge[] = [
    makeGhostEdge(`${prefix}-partner-B`, `${prefix}-awsdev-B`),
    ...ghostSinkEdges(`${prefix}-awsdev-B`, sinks),
  ];

  if (target === 'maximum') {
    nodes.push(
      makeGhostNode(`${prefix}-partner-B-2`, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: deviceLocCode } }),
      makeGhostNode(`${prefix}-awsdev-B-2`, 'awsDevice', 'AWS Device', { details: { locationCode: deviceLocCode } }),
    );
    edges.push(
      makeGhostEdge(`${prefix}-partner-B-2`, `${prefix}-awsdev-B-2`),
      ...ghostSinkEdges(`${prefix}-awsdev-B-2`, sinks),
    );
  }

  return { nodes, edges };
}

export interface ExtraDeviceOptions {
  /** ID prefix for the minted nodes/edges. */
  prefix: string;
  /** Location code the extra device belongs to (an existing location). */
  location: string;
  /** Upstreams the new ghost AWS device connects to. */
  sinks: GhostSink[];
  /**
   * Member-connection count the ghost LAG should mirror (only used by
   * `lagDeviceGhost`). Copied from the neighbouring real LAG at this location so
   * the recommended LAG draws the same number of connections. Clamped to ≥2.
   */
  memberCount?: number;
}

/**
 * A single extra partner+AWS-device pair at an EXISTING location — closing the
 * device-redundancy gap for Maximum resiliency. The chain STARTS at the new
 * Customer / Partner Device (per the design rule) and flows inward to each sink;
 * it deliberately does NOT draw an edge back to the location's on-prem / customer
 * data center node, since that customer-side cabling isn't what AWS recommends.
 */
export function extraDeviceGhost(opts: ExtraDeviceOptions): {
  nodes: DxNode[];
  edges: DxEdge[];
} {
  const { prefix, location, sinks } = opts;

  const nodes: DxNode[] = [
    makeGhostNode(`${prefix}-partner-${location}-2`, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: location } }),
    makeGhostNode(`${prefix}-awsdev-${location}-2`, 'awsDevice', 'AWS Device', { details: { locationCode: location } }),
  ];

  const edges: DxEdge[] = [
    makeGhostEdge(`${prefix}-partner-${location}-2`, `${prefix}-awsdev-${location}-2`),
    ...ghostSinkEdges(`${prefix}-awsdev-${location}-2`, sinks),
  ];

  return { nodes, edges };
}

/**
 * Like `extraDeviceGhost`, but the extra device at the EXISTING location is
 * fronted by a recommended LAG — used when that location's real sink path is
 * itself LAG-backed, so the redundant ghost mirrors the LAG shape rather than a
 * plain connection.
 */
export function lagDeviceGhost(opts: ExtraDeviceOptions): {
  nodes: DxNode[];
  edges: DxEdge[];
} {
  const { prefix, location, sinks, memberCount = 2 } = opts;

  const partnerId = `${prefix}-partner-${location}-2`;
  const lagId = `${prefix}-lag-${location}-2`;
  const awsId = `${prefix}-awsdev-${location}-2`;

  const nodes: DxNode[] = [
    makeGhostNode(partnerId, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: location } }),
    makeGhostNode(lagId, 'lag', 'LAG (Recommended)', { details: { locationCode: location } }),
    makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: location } }),
  ];

  const edges: DxEdge[] = [
    ...ghostLagEdges(partnerId, lagId, awsId, memberCount),
    ...ghostSinkEdges(awsId, sinks),
  ];

  return { nodes, edges };
}

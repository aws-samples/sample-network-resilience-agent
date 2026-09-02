import type { DxEdge } from '../types/topology';

/**
 * The edge kinds a user is allowed to draw on the canvas. Both describe
 * customer-side cabling that no AWS API reports, which is exactly why they are
 * hand-drawn rather than discovered:
 *
 * `crossConnect` — customer router → DX partner device. The cross-connect
 *   inside the colo cage.
 * `customerLink` — a link between two customer-owned devices of the SAME kind:
 *   router ↔ router in the customer sites, or Customer Gateway ↔ Customer
 *   Gateway in the DX locations. Either an HA pair in one place, or a link
 *   between two of them. Without it a reader cannot tell devices that back each
 *   other up from single points of failure sitting side by side.
 */
export type UserEdgeKind = 'crossConnect' | 'customerLink';

/**
 * Node categories whose members may be linked to one another. Both are customer
 * hardware — the on-prem router (`onPremise`, shown as "Customer Router") and
 * the customer's device in the colo (`dxPartnerDevice`, shown as "Customer
 * Gateway") — and AWS reports the cabling between neither, which is why the
 * links are drawn rather than discovered.
 *
 * A link needs both ends in the SAME category. A router paired with a colo
 * device is the cross-connect above, not a peer link, and it is matched first.
 */
const LINKABLE_PEER_CATEGORIES = new Set(['onPremise', 'dxPartnerDevice']);

/**
 * One endpoint of an attempted connection. `y` is the node's absolute canvas
 * position and is needed only to decide which end of a customer link becomes
 * the source.
 */
export interface ConnectEndpoint {
  id: string;
  category: string;
  y: number;
}

export interface PlannedUserEdge {
  kind: UserEdgeKind;
  edge: DxEdge;
}

/**
 * The `data` payload every customer link carries, in one place so a link built
 * fresh and a link restored from storage cannot end up with different flags.
 *
 * Deliberately unlabelled, matching the cross-connect: the line between two
 * cards of the same kind says what it is, and a label box would only crowd a
 * column that is already tight. `isPeering` still gives it point-to-point hover
 * from the edge body, which is where the gesture lands with no label to hit.
 */
const CUSTOMER_LINK_DATA = { isPeering: true, isLateral: true } as const;

/**
 * Id for a customer link, deliberately independent of the drag direction: A→B
 * and B→A are the same piece of cable. `addUserEdge` de-duplicates by id, so a
 * redraw the other way round is a no-op instead of a second edge stacked on the
 * first.
 */
const CUSTOMER_LINK_ID_PREFIX = 'user-link-';

export function customerLinkId(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return `${CUSTOMER_LINK_ID_PREFIX}${lo}--${hi}`;
}

/**
 * Restate the customer-link `data` on edges restored from localStorage or from a
 * snapshot file. Both persist whatever the app wrote at the time, so a link
 * drawn by an older build comes back with that build's payload: missing
 * `isLateral`, which decides whether the end-to-end highlight covers the link,
 * and carrying the "Customer Link" label that has since been dropped. Neither
 * would correct itself until the user redrew the link.
 *
 * Identified by id, which is generated and unique to customer links.
 */
export function normalizeUserEdges(edges: DxEdge[]): DxEdge[] {
  return edges.map((e) => {
    if (!e.id.startsWith(CUSTOMER_LINK_ID_PREFIX)) return e;
    const data = { ...e.data, ...CUSTOMER_LINK_DATA };
    delete data.label;
    return { ...e, data };
  });
}

/**
 * Decide whether the connection the user just dragged is allowed, and if so
 * what edge it becomes. Returns null for everything else — the gesture is then
 * discarded and the canvas is left unchanged.
 *
 * Pure, so the rules can be tested without mounting FlowCanvas.
 */
export function planUserEdge(
  src: ConnectEndpoint | undefined,
  tgt: ConnectEndpoint | undefined,
  handles: { sourceHandle?: string | null; targetHandle?: string | null } = {},
): PlannedUserEdge | null {
  if (!src || !tgt) return null;
  // React Flow hands over a self-loop if the drag ends back on the node it
  // started from.
  if (src.id === tgt.id) return null;

  if (src.category === 'onPremise' && tgt.category === 'dxPartnerDevice') {
    return {
      kind: 'crossConnect',
      edge: {
        id: `user-${src.id}-${tgt.id}`,
        source: src.id,
        target: tgt.id,
        sourceHandle: handles.sourceHandle ?? undefined,
        targetHandle: handles.targetHandle ?? undefined,
        type: 'customEdge',
      },
    };
  }

  if (src.category === tgt.category && LINKABLE_PEER_CATEGORIES.has(src.category)) {
    return { kind: 'customerLink', edge: makeCustomerLink(src, tgt) };
  }

  return null;
}

/**
 * Whether an edge joining these two categories is one the user drew by hand.
 * Answered by running the connect rules themselves, so the set of edges that
 * offer a delete affordance can never drift from the set that can be created —
 * and nothing else in the app can remove one, so that affordance is the only way
 * back.
 */
export function isUserDrawnPair(
  sourceCategory: string | undefined,
  targetCategory: string | undefined,
): boolean {
  if (!sourceCategory || !targetCategory) return false;
  return planUserEdge(
    { id: 'src', category: sourceCategory, y: 0 },
    { id: 'tgt', category: targetCategory, y: 1 },
  ) !== null;
}

/**
 * Customer links always route bottom → top, overriding whichever handles the
 * user happened to grab. Customer routers all share one column, so the two ends
 * are stacked vertically; a right→left edge between them loops backwards around
 * both cards and reads as a routing bug rather than a link. Anchoring the upper
 * node as the source drops the line straight down instead.
 *
 * The direction is cosmetic — the cable is bidirectional — so an exact tie on y
 * breaks on id, keeping the result stable whichever way the user dragged.
 */
function makeCustomerLink(a: ConnectEndpoint, b: ConnectEndpoint): DxEdge {
  const aIsUpper = a.y !== b.y ? a.y < b.y : a.id < b.id;
  const [from, to] = aIsUpper ? [a, b] : [b, a];
  return {
    id: customerLinkId(a.id, b.id),
    source: from.id,
    target: to.id,
    sourceHandle: 'bottom',
    targetHandle: 'top',
    type: 'customEdge',
    // `isPeering` — point-to-point, like a VPC↔VPC or TGW↔TGW peering: hovering
    // it highlights the two devices it joins rather than running a full
    // end-to-end BFS through both of their paths.
    // `isLateral` — and it is not a step along anyone's path either, so the
    // end-to-end traversal must not walk *through* it. Without this the
    // highlight inherited the direction chosen above, which is cosmetic: the
    // link showed up when clicking one side of it and vanished from the other.
    data: { ...CUSTOMER_LINK_DATA },
  };
}

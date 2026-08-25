import { create } from 'zustand';
import type { DxNode, DxEdge, TopologyData, ViewMode } from '../types/topology';
import type { CombinedAssessment } from '../types/recommendations';
import type { ResiliencyTarget } from '../engine/resiliency-rules';
import type { AwsCredentials } from '../types/aws-resources';
import { WELCOME_MESSAGE, type MockScenario } from '../utils/shared';
import { config } from '../utils/config';
import { fetchUtilization } from '../api/cloudwatch-utilization';
import { deserializeTopologyData, type SnapshotFile } from '../utils/snapshot';
import { normalizeUserEdges } from '../utils/user-edges';

// Metadata exposed to the UI when an imported snapshot is being viewed.
// Banner / TopBar read this to render the "Viewing imported snapshot" affordances.
export interface ImportedSnapshotInfo {
  exportedAt: string;
  appVersion?: string;
  redactedView: boolean;
  customerNote?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface TopologyStore {
  credentials: AwsCredentials | null;
  setCredentials: (creds: AwsCredentials | null) => void;

  topologyData: TopologyData | null;
  setTopologyData: (data: TopologyData) => void;
  // Clear the canvas back to the cold-start blank state (no topology, graph, or
  // assessment). Used by sign-out and session-timeout so the signed-out canvas
  // matches cold start — blank behind the WelcomeBanner — instead of silently
  // reloading the mock demo scenario. No-op while an imported snapshot is
  // pinned, mirroring loadTopology's guard so neither path clobbers it.
  resetTopology: () => void;

  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;

  error: string | null;
  setError: (error: string | null) => void;

  currentNodes: DxNode[];
  currentEdges: DxEdge[];
  setCurrentGraph: (nodes: DxNode[], edges: DxEdge[]) => void;

  recommendedNodes: DxNode[];
  recommendedEdges: DxEdge[];
  recommendedCurrentNodes: DxNode[]; // current nodes repositioned for recommended view
  setRecommendedGraph: (nodes: DxNode[], edges: DxEdge[], currentForRec?: DxNode[]) => void;

  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  assessment: CombinedAssessment | null;
  setAssessment: (assessment: CombinedAssessment) => void;

  // User-selected target tier for recommendations, keyed by directConnectGatewayId.
  // Each DXGW can have its own High/Maximum target since the recommendation engine
  // evaluates resiliency rules per-gateway. A missing key defaults to 'high' at the
  // consumer — we don't seed the record so new DXGWs pick up the default automatically.
  resiliencyTargets: Record<string, ResiliencyTarget>;
  setResiliencyTarget: (dxGatewayId: string, target: ResiliencyTarget) => void;

  // When set, the Recommended view renders ghost nodes only for this DXGW.
  // Lets users preview an upgrade for a single gateway without the ghosts from
  // every other DXGW cluttering the canvas. Cleared when switching back to
  // Current State or when the user explicitly exits focus.
  focusedDxGatewayId: string | null;
  setFocusedDxGatewayId: (id: string | null) => void;

  chatMessages: ChatMessage[];
  addChatMessage: (message: ChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  isChatLoading: boolean;
  setIsChatLoading: (loading: boolean) => void;
  clearChat: () => void;
  chatAbortController: AbortController | null;
  setChatAbortController: (controller: AbortController | null) => void;
  cancelChat: () => void;

  theme: 'dark' | 'light';
  toggleTheme: () => void;

  useMock: boolean;
  mockScenario: MockScenario;
  setMockScenario: (scenario: MockScenario) => void;

  updateNodePositions: (changes: { id: string; position: { x: number; y: number } }[]) => void;

  expandedVpcGroups: Set<string>;
  toggleVpcGroup: (regionId: string) => void;

  vpcGroupViewMode: Map<string, 'table'>;
  toggleVpcGroupTable: (groupKey: string) => void;

  expandedTgwGroups: Set<string>;
  toggleTgwGroup: (regionId: string) => void;

  expandedPartnerGroups: Set<string>;
  togglePartnerGroup: (groupKey: string) => void;

  // Region codes where the user has opted in to showing VPCs reachable only
  // via non-DX TGWs/VGWs (hidden by default).
  showNonDxVpcs: Set<string>;
  toggleShowNonDxVpcs: (regionCode: string) => void;

  expandedIsolatedTgwGroups: Set<string>;
  toggleIsolatedTgwGroup: (regionId: string) => void;

  isolatedTgwGroupViewMode: Map<string, 'table'>;
  toggleIsolatedTgwGroupTable: (groupKey: string) => void;

  expandedTgwRoutePanels: Set<string>;
  toggleTgwRoutePanel: (tgwId: string) => void;

  expandedVpcRoutePanels: Set<string>;
  toggleVpcRoutePanel: (vpcId: string) => void;

  expandedVpcPeerPanels: Set<string>;
  toggleVpcPeerPanel: (vpcId: string) => void;

  expandedCloudWanRoutePanels: Set<string>;
  toggleCloudWanRoutePanel: (coreNetworkId: string) => void;

  showVpcs: boolean;
  setShowVpcs: (show: boolean) => void;

  // Unattached resources zone (orphan VPCs + isolated TGWs) lives inside
  // AWS Cloud and is collapsed by default so the canvas loads focused on
  // DX-connected topology. Users expand it to inspect the stranded
  // resources. Persisted in memory per session only.
  expandedUnattachedZone: boolean;
  toggleUnattachedZone: () => void;

  // Hidden associations zone (prefix-pool / EDGLESS DXGW associations whose
  // target gateway identity AWS redacts from the public API). Same expansion
  // pattern as the unattached zone.
  expandedHiddenAssocZone: boolean;
  toggleHiddenAssocZone: () => void;

  bedrockStatus: 'idle' | 'connected' | 'error';
  setBedrockStatus: (status: 'idle' | 'connected' | 'error') => void;

  // Credentials modal visibility lives in the store so affordances outside
  // the top bar (e.g. the empty-state banner rendered over the canvas) can
  // open it without prop-drilling a callback through the tree.
  credentialsModalOpen: boolean;
  setCredentialsModalOpen: (open: boolean) => void;

  // Live status overlay
  showLiveStatus: boolean;
  toggleLiveStatus: () => void;

  // Redact mode — display-only masking of AWS identifiers (account IDs,
  // resource IDs, IPs, CIDRs, ASNs) in the rendered UI. Does NOT alter what
  // the chat sends to Bedrock; only what's painted on screen.
  redactMode: boolean;
  toggleRedactMode: () => void;

  // CloudWatch utilization overlay (gated behind live status). Calling the
  // load action hits CloudWatch GetMetricData, so results are cached per
  // window for the lifetime of a topology — toggling 30→60→30 within the
  // same session re-uses the prior fetch instead of re-billing.
  showUtilization: boolean;
  setShowUtilization: (show: boolean) => void;
  utilizationWindowDays: 30 | 60 | 90;
  setUtilizationWindowDays: (days: 30 | 60 | 90) => void;
  utilizationLoading: boolean;
  utilizationError: string | null;
  utilizationCache: Map<30 | 60 | 90, { vif: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>; connection: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }> }>;
  loadUtilization: (windowDays: 30 | 60 | 90) => Promise<void>;
  resetUtilization: () => void;

  // Edge label drag offsets
  edgeLabelOffsets: Map<string, { dx: number; dy: number }>;
  setEdgeLabelOffset: (edgeId: string, dx: number, dy: number) => void;

  // User-resized customer site container dimensions
  nodeSizeOverrides: Map<string, { width: number; height: number }>;
  setNodeSizeOverride: (nodeId: string, width: number, height: number) => void;
  clearNodeSizeOverrides: () => void;
  updateNodeDimensions: (changes: { id: string; width: number; height: number }[]) => void;

  // User-rewired edge endpoints (CGW → DX device reconnection)
  edgeReconnectOverrides: Map<string, { source: string; target: string }>;
  setEdgeReconnectOverride: (edgeId: string, source: string, target: string) => void;
  clearEdgeReconnectOverrides: () => void;

  // User-hidden edges (onPremise → dxPartnerDevice removals)
  hiddenEdgeIds: Set<string>;
  hideEdge: (edgeId: string) => void;
  unhideEdge: (edgeId: string) => void;
  clearHiddenEdges: () => void;

  // User-created edges (new connections between onPremise → dxPartnerDevice)
  userEdges: DxEdge[];
  addUserEdge: (edge: DxEdge) => void;
  clearUserEdges: () => void;

  // User-created Customer Data Center zones (empty containers the user adds via the + button)
  userCustomerSites: DxNode[];
  addUserCustomerSite: () => void;
  removeUserCustomerSite: (id: string) => void;
  updateUserCustomerSitePosition: (id: string, position: { x: number; y: number }) => void;
  updateUserCustomerSiteDimensions: (id: string, width: number, height: number) => void;
  clearUserCustomerSites: () => void;

  // User-hidden Customer Data Center zones (real AWS-derived sites the user removed via the × button)
  hiddenCustomerSiteIds: Set<string>;
  hideCustomerSite: (id: string) => void;
  unhideCustomerSite: (id: string) => void;
  clearHiddenCustomerSites: () => void;

  // User-created Customer Router nodes (added via the + button on an existing router).
  // Each one lives inside a Customer Data Center zone identified by parentSiteId.
  userOnPremises: DxNode[];
  addUserOnPremise: (parentSiteId: string) => void;
  removeUserOnPremise: (id: string) => void;
  updateUserOnPremisePosition: (id: string, position: { x: number; y: number }) => void;

  // User-hidden Customer Router nodes (real AWS-derived routers removed via the × button).
  hiddenOnPremiseIds: Set<string>;
  hideOnPremise: (id: string) => void;
  unhideOnPremise: (id: string) => void;
  clearHiddenOnPremises: () => void;

  reparentNodeToContainer: (nodeId: string, newParentId: string, relativePosition: { x: number; y: number }) => void;

  // Failure simulation
  isSimulating: boolean;
  setIsSimulating: (simulating: boolean) => void;
  failedNodeIds: Set<string>;
  failedEdgeIds: Set<string>;
  toggleNodeFailure: (id: string) => void;
  toggleEdgeFailure: (id: string) => void;
  failZone: (nodeIds: string[], edgeIds: string[]) => void;
  clearFailures: () => void;

  // Home account display name (from SSO)
  homeAccountName: string | null;
  setHomeAccountName: (name: string | null) => void;

  // Canvas lock (prevent dragging nodes/edges)
  isLocked: boolean;
  setIsLocked: (locked: boolean) => void;

  // Hover-to-highlight: BFS from hovered node reveals all transitively-connected nodes/edges
  hoveredNodeId: string | null;
  highlightedNodeIds: Set<string>;
  highlightedEdgeIds: Set<string>;
  setHoveredNode: (id: string | null) => void;

  // Highlight a single lateral edge + its two endpoints only, dimming the rest.
  // Used for peering edges (VPC↔VPC, TGW↔TGW, Cloud WAN↔TGW), where the E2E BFS
  // path used by setHoveredNode would over-highlight the requester's upstream
  // and all its other peerings. Pass null to clear.
  setHoveredEdge: (edgeId: string | null, source?: string, target?: string) => void;

  // Pinned path: a clicked node freezes the hover-highlight so it survives
  // mouse-leave. `setHoveredNode` is a no-op while a pin is active, so the
  // pinned path stays lit until the user clicks the pane or the same node
  // again. Only one pin at a time.
  pinnedNodeId: string | null;
  setPinnedNode: (id: string | null) => void;

  // Spotlight: attention cue from out-of-canvas affordances (e.g. scorecard
  // DXGW rows, bulk tier picker hover). Kept separate from `hoveredNodeId` so
  // the in-canvas path-dimming behavior isn't triggered. Holds a set so a
  // single affordance can light up multiple nodes at once (e.g. hovering a
  // bulk-tier option spotlights every DXGW the choice would affect).
  spotlightNodeIds: Set<string>;
  setSpotlightNode: (id: string | null) => void;
  setSpotlightNodes: (ids: Iterable<string>) => void;

  // Edge counterpart to `spotlightNodeIds` — used when a maintenance notice
  // calls out a VIF (which lives on an edge, not a node), so hovering the
  // dxvif-* chip lights up the actual VIF path rather than the DXGW it
  // terminates on.
  spotlightEdgeIds: Set<string>;
  setSpotlightEdge: (id: string | null) => void;

  // Monotonic counter incremented on every topology refresh. Subscribers
  // (e.g. `ChatInput`) watch this to reset UI state that should follow a
  // refresh, without having to plumb a ref through every component.
  topologyRefreshNonce: number;
  bumpTopologyRefresh: () => void;

  // Imported snapshot mode — set when the SA loads a customer-exported JSON
  // file. While non-null the canvas renders the imported topology and
  // `loadTopology` is suppressed (see useTopology.ts) so neither Refresh nor
  // session-timeout can clobber the imported view with the SA's own AWS data.
  importedSnapshot: ImportedSnapshotInfo | null;
  loadSnapshot: (file: SnapshotFile) => void;
  clearImportedSnapshot: () => void;
}

// --- localStorage helpers for node size + edge reconnect overrides ---
const SIZE_STORAGE_KEY = 'dx-viz-node-sizes';
const REWIRE_STORAGE_KEY = 'dx-viz-edge-rewires';
const HIDDEN_EDGES_KEY = 'dx-viz-hidden-edges';
const USER_EDGES_KEY = 'dx-viz-user-edges';
const USER_CUSTOMER_SITES_KEY = 'dx-viz-user-customer-sites';
const HIDDEN_CUSTOMER_SITES_KEY = 'dx-viz-hidden-customer-sites';
const USER_ONPREMISES_KEY = 'dx-viz-user-onpremises';
const HIDDEN_ONPREMISES_KEY = 'dx-viz-hidden-onpremises';

// One-shot migration: the customer-router → partner-device edge is no longer
// auto-drawn, so any persisted user-drawn edges from before that change would
// render as stale leftovers. Clear them once on load — the sentinel ensures
// later user-drawn edges aren't wiped on every refresh.
const USER_EDGES_RESET_SENTINEL = 'dx-viz-user-edges-reset-v1';
try {
  if (!localStorage.getItem(USER_EDGES_RESET_SENTINEL)) {
    localStorage.removeItem(USER_EDGES_KEY);
    localStorage.setItem(USER_EDGES_RESET_SENTINEL, '1');
  }
} catch { /* ignore */ }

function loadMapFromStorage<V>(key: string): Map<string, V> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Map(Object.entries(JSON.parse(raw) as Record<string, V>));
  } catch { /* ignore */ }
  return new Map();
}

function saveMapToStorage<V>(key: string, map: Map<string, V>) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch { /* ignore */ }
}

function loadSetFromStorage(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveSetToStorage(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch { /* ignore */ }
}

// Node-size overrides are intentionally in-memory only — clear any stale
// persisted state so a browser refresh reverts the Customer Data Center zone
// to its auto-computed layout size.
try { localStorage.removeItem(SIZE_STORAGE_KEY); } catch { /* ignore */ }

// --- localStorage helper for redact mode ---
//
// Persists across reloads so an accidental refresh during a screenshare
// doesn't unmask the topology.
const REDACT_STORAGE_KEY = 'dx-visualizer.redactMode';
function loadRedactMode(): boolean {
  try { return localStorage.getItem(REDACT_STORAGE_KEY) === '1'; } catch { return false; }
}

// --- localStorage helpers for chat persistence ---
//
// Privacy boundary: the persisted transcript is unencrypted and may include
// whatever topology facts the model surfaced — AWS account IDs, VPC CIDRs,
// customer gateway IPs, DXGW/VIF names. Treat the user's browser profile as
// the trust boundary; anything with filesystem or DevTools access to this
// origin's localStorage can read it. This POC is not intended for shared
// devices. The in-memory `chatMessages` array is not truncated — only what
// we write to disk is capped.
const CHAT_STORAGE_KEY = 'dx-viz-chat';
const MAX_PERSISTED_MESSAGES = 100;

function trimForPersistence(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_PERSISTED_MESSAGES
    ? messages.slice(-MAX_PERSISTED_MESSAGES)
    : messages;
}

function loadChatFromStorage(): ChatMessage[] | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ChatMessage[];
  } catch { /* ignore */ }
  return null;
}

function saveChatToStorage(messages: ChatMessage[]) {
  const trimmed = trimForPersistence(messages);
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Most likely QuotaExceededError. Retry with a shorter tail so a single
    // oversized message (e.g. a big embedded JSON tool result) doesn't wedge
    // the whole persistence path — losing older history beats blocking new
    // messages from being saved at all.
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed.slice(-20)));
    } catch { /* give up silently */ }
  }
}

// Debounced variant used during streaming so we don't re-serialize the full
// chat history on every token. 250ms trailing — the final flush lands on the
// next user/assistant message boundary via addChatMessage().
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function cancelScheduledSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
function scheduleSaveChatToStorage(messages: ChatMessage[]) {
  cancelScheduledSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveChatToStorage(messages);
  }, 250);
}

const savedChat = (() => {
  const msgs = loadChatFromStorage();
  if (msgs && msgs.length > 0 && msgs[0].id === 'welcome') {
    msgs[0] = { ...msgs[0], timestamp: Date.now() };
  }
  return msgs;
})();

// Cache for hover path adjacency maps, keyed by the (currentEdges, recommendedEdges)
// tuple identity. Rebuilt only when the edge arrays themselves change, not on every
// mouse-enter. Separate caches per view mode because 'current' ignores recommendedEdges.
type AdjMaps = {
  incoming: Map<string, { edgeId: string; source: string }[]>;
  outgoing: Map<string, { edgeId: string; target: string }[]>;
  // `isLateral` edges, keyed by BOTH endpoints. They are deliberately absent
  // from incoming/outgoing: see computePath.
  lateral: Map<string, { edgeId: string; peer: string }[]>;
};
const currentAdjCache = new WeakMap<DxEdge[], WeakMap<DxEdge[], AdjMaps>>();
const recommendedAdjCache = new WeakMap<DxEdge[], WeakMap<DxEdge[], WeakMap<DxEdge[], AdjMaps>>>();

function buildAdjMaps(edges: DxEdge[]): AdjMaps {
  const incoming = new Map<string, { edgeId: string; source: string }[]>();
  const outgoing = new Map<string, { edgeId: string; target: string }[]>();
  const lateral = new Map<string, { edgeId: string; peer: string }[]>();
  const addLateral = (from: string, edgeId: string, peer: string) => {
    if (!lateral.has(from)) lateral.set(from, []);
    lateral.get(from)!.push({ edgeId, peer });
  };
  for (const e of edges) {
    if (e.data?.isLateral) {
      // Recorded from both ends and kept out of the directed graph, so the
      // traversal can never walk *through* it in whichever direction it was
      // drawn.
      addLateral(e.source, e.id, e.target);
      addLateral(e.target, e.id, e.source);
      continue;
    }
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    incoming.get(e.target)!.push({ edgeId: e.id, source: e.source });
    outgoing.get(e.source)!.push({ edgeId: e.id, target: e.target });
  }
  return { incoming, outgoing, lateral };
}

function getAdjMaps(
  viewMode: ViewMode,
  currentEdges: DxEdge[],
  recommendedEdges: DxEdge[],
  userEdges: DxEdge[],
): AdjMaps {
  if (viewMode !== 'recommended') {
    let inner = currentAdjCache.get(currentEdges);
    if (!inner) {
      inner = new WeakMap<DxEdge[], AdjMaps>();
      currentAdjCache.set(currentEdges, inner);
    }
    let maps = inner.get(userEdges);
    if (!maps) {
      maps = buildAdjMaps([...currentEdges, ...userEdges]);
      inner.set(userEdges, maps);
    }
    return maps;
  }
  let mid = recommendedAdjCache.get(currentEdges);
  if (!mid) {
    mid = new WeakMap<DxEdge[], WeakMap<DxEdge[], AdjMaps>>();
    recommendedAdjCache.set(currentEdges, mid);
  }
  let inner = mid.get(recommendedEdges);
  if (!inner) {
    inner = new WeakMap<DxEdge[], AdjMaps>();
    mid.set(recommendedEdges, inner);
  }
  let maps = inner.get(userEdges);
  if (!maps) {
    maps = buildAdjMaps([...currentEdges, ...recommendedEdges, ...userEdges]);
    inner.set(userEdges, maps);
  }
  return maps;
}

// End-to-end path for a given node. Edges in this graph are directed left-to-right:
// on-prem → partner → AWS device → DXGW → TGW/VGW → VPC (and VPN → VGW).
// To avoid pulling in sibling branches at shared hubs (e.g. both DXGW and VPN
// feed into the same VGW), we traverse directionally — upstream follows
// target→source, downstream follows source→target. A middle node therefore
// shows only its own E2E path, not every path sharing the same hub.
function computePath(
  id: string,
  state: { viewMode: ViewMode; currentEdges: DxEdge[]; recommendedEdges: DxEdge[]; userEdges: DxEdge[] },
): { nodes: Set<string>; edges: Set<string> } {
  const { incoming, outgoing, lateral } = getAdjMaps(state.viewMode, state.currentEdges, state.recommendedEdges, state.userEdges);
  const nodes = new Set<string>([id]);
  const edges = new Set<string>();
  const upQueue: string[] = [id];
  while (upQueue.length > 0) {
    const n = upQueue.shift()!;
    const preds = incoming.get(n);
    if (!preds) continue;
    for (const { edgeId, source } of preds) {
      edges.add(edgeId);
      if (!nodes.has(source)) {
        nodes.add(source);
        upQueue.push(source);
      }
    }
  }
  const downQueue: string[] = [id];
  while (downQueue.length > 0) {
    const n = downQueue.shift()!;
    const succs = outgoing.get(n);
    if (!succs) continue;
    for (const { edgeId, target } of succs) {
      edges.add(edgeId);
      if (!nodes.has(target)) {
        nodes.add(target);
        downQueue.push(target);
      }
    }
  }
  // Lateral cables hang off the finished path rather than extending it. A
  // Customer Link is bidirectional kit-to-kit cabling whose drawn direction is
  // only a routing choice, so walking it like a path step made the highlight
  // depend on which end was the upper one: clicking the DX gateway caught the
  // link (it sits upstream of the lower device) while clicking the AWS device
  // behind the upper one missed it.
  //
  // Attaching it here instead covers it from either side. One hop only — the far
  // device joins the highlight so the redundant pair reads as related, but its
  // own upstream and downstream stay out, because the link means "these two back
  // each other up", not "these two are one path". Iterating a snapshot keeps it
  // to that one hop.
  for (const n of [...nodes]) {
    const sides = lateral.get(n);
    if (!sides) continue;
    for (const { edgeId, peer } of sides) {
      edges.add(edgeId);
      nodes.add(peer);
    }
  }
  return { nodes, edges };
}

export const useTopologyStore = create<TopologyStore>((set, get) => ({
  credentials: null,
  setCredentials: (creds) => set({ credentials: creds, useMock: !creds, homeAccountName: null }),

  topologyData: null,
  setTopologyData: (data) => set({ topologyData: data }),
  resetTopology: () => {
    // Guard against wiping a pinned imported snapshot — same invariant as
    // loadTopology(). The SA must Exit the imported view explicitly.
    if (get().importedSnapshot != null) return;
    // Drop live-account user customizations and cached utilization so the
    // prior session's edges/sites don't linger (in localStorage or in the
    // graph) while signed out — mirrors the exact cleanup loadTopology()
    // runs before every fetch.
    get().clearUserEdges();
    get().clearHiddenEdges();
    get().clearEdgeReconnectOverrides();
    get().clearUserCustomerSites();
    get().clearHiddenCustomerSites();
    get().resetUtilization();
    set({
      topologyData: null,
      currentNodes: [],
      currentEdges: [],
      recommendedNodes: [],
      recommendedEdges: [],
      recommendedCurrentNodes: [],
      assessment: null,
      homeAccountName: null,
      error: null,
      isLoading: false,
      // Clear any in-flight selection / simulation state so a later demo /
      // reconnect starts clean, matching loadSnapshot's reset.
      hoveredNodeId: null,
      pinnedNodeId: null,
      highlightedNodeIds: new Set(),
      highlightedEdgeIds: new Set(),
      spotlightNodeIds: new Set(),
      spotlightEdgeIds: new Set(),
      isSimulating: false,
      failedNodeIds: new Set(),
      failedEdgeIds: new Set(),
    });
  },

  isLoading: false,
  setIsLoading: (loading) => set({ isLoading: loading }),

  error: null,
  setError: (error) => set({ error }),

  currentNodes: [],
  currentEdges: [],
  setCurrentGraph: (nodes, edges) =>
    set((state) => {
      const base = { currentNodes: nodes, currentEdges: edges };
      // If the user has a pinned path, the adjacency graph just changed under
      // it (e.g. expanding a collapsed group surfaces new child nodes/edges).
      // Recompute the BFS so the freshly-revealed children inherit the path
      // highlight instead of appearing dimmed.
      if (state.pinnedNodeId != null) {
        const next = { ...state, ...base };
        const path = computePath(state.pinnedNodeId, next);
        return { ...base, highlightedNodeIds: path.nodes, highlightedEdgeIds: path.edges };
      }
      return base;
    }),

  recommendedNodes: [],
  recommendedEdges: [],
  recommendedCurrentNodes: [],
  setRecommendedGraph: (nodes, edges, currentForRec) =>
    set((state) => {
      const base = {
        recommendedNodes: nodes,
        recommendedEdges: edges,
        recommendedCurrentNodes: currentForRec ?? [],
      };
      if (state.pinnedNodeId != null) {
        const next = { ...state, ...base };
        const path = computePath(state.pinnedNodeId, next);
        return { ...base, highlightedNodeIds: path.nodes, highlightedEdgeIds: path.edges };
      }
      return base;
    }),

  viewMode: 'current',
  setViewMode: (mode) =>
    set((state) => ({
      viewMode: mode,
      focusedDxGatewayId: mode === 'current' ? null : state.focusedDxGatewayId,
    })),

  assessment: null,
  setAssessment: (assessment) => set({ assessment }),

  resiliencyTargets: {},
  setResiliencyTarget: (dxGatewayId, target) =>
    set((state) => ({
      resiliencyTargets: { ...state.resiliencyTargets, [dxGatewayId]: target },
    })),

  focusedDxGatewayId: null,
  setFocusedDxGatewayId: (id) => set({ focusedDxGatewayId: id }),

  chatMessages: savedChat ?? [
    {
      id: 'welcome',
      role: 'assistant',
      content: WELCOME_MESSAGE,
      timestamp: Date.now(),
    },
  ],
  addChatMessage: (message) =>
    set((state) => {
      const chatMessages = [...state.chatMessages, message];
      cancelScheduledSave();
      saveChatToStorage(chatMessages);
      return { chatMessages };
    }),
  updateLastAssistantMessage: (content) =>
    set((state) => {
      const messages = [...state.chatMessages];
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
        messages[lastIdx] = { ...messages[lastIdx], content };
      }
      scheduleSaveChatToStorage(messages);
      return { chatMessages: messages };
    }),
  isChatLoading: false,
  setIsChatLoading: (loading) => set({ isChatLoading: loading }),
  chatAbortController: null,
  setChatAbortController: (controller) => set({ chatAbortController: controller }),
  cancelChat: () => {
    const controller = get().chatAbortController;
    if (controller) controller.abort();
    set({ chatAbortController: null, isChatLoading: false });
  },
  clearChat: () => {
    const chatMessages = [{
      id: 'welcome',
      role: 'assistant' as const,
      content: WELCOME_MESSAGE,
      timestamp: Date.now(),
    }];
    cancelScheduledSave();
    saveChatToStorage(chatMessages);
    set({ chatMessages });
  },

  theme: 'dark',
  toggleTheme: () =>
    set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

  useMock: true,
  mockScenario: config.defaultScenario,
  setMockScenario: (scenario) =>
    set((state) => {
      if (state.mockScenario === scenario) return {};
      // Node IDs differ across scenarios, so any persisted edge customizations
      // from the prior scenario would render as stray edges pointing at nodes
      // that no longer exist.
      try { localStorage.removeItem(USER_EDGES_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem(HIDDEN_EDGES_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem(REWIRE_STORAGE_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem(USER_CUSTOMER_SITES_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem(HIDDEN_CUSTOMER_SITES_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem(USER_ONPREMISES_KEY); } catch { /* ignore */ }
      try { localStorage.removeItem(HIDDEN_ONPREMISES_KEY); } catch { /* ignore */ }
      return {
        mockScenario: scenario,
        userEdges: [],
        hiddenEdgeIds: new Set(),
        edgeReconnectOverrides: new Map(),
        userCustomerSites: [],
        hiddenCustomerSiteIds: new Set(),
        userOnPremises: [],
        hiddenOnPremiseIds: new Set(),
      };
    }),

  updateNodePositions: (changes) =>
    set((state) => {
      const posMap = new Map(changes.map((c) => [c.id, c.position]));
      const updateList = (nodes: DxNode[]) => {
        let changed = false;
        const next = nodes.map((n) => {
          const pos = posMap.get(n.id);
          if (!pos) return n;
          changed = true;
          return { ...n, position: pos };
        });
        return changed ? next : nodes;
      };
      const currentNodes = updateList(state.currentNodes);
      const recommendedNodes = updateList(state.recommendedNodes);
      const recommendedCurrentNodes = updateList(state.recommendedCurrentNodes);
      const patch: Partial<TopologyStore> = {};
      if (currentNodes !== state.currentNodes) patch.currentNodes = currentNodes;
      if (recommendedNodes !== state.recommendedNodes) patch.recommendedNodes = recommendedNodes;
      if (recommendedCurrentNodes !== state.recommendedCurrentNodes) patch.recommendedCurrentNodes = recommendedCurrentNodes;
      return patch;
    }),

  expandedVpcGroups: new Set(),
  toggleVpcGroup: (regionId) =>
    set((state) => {
      const next = new Set(state.expandedVpcGroups);
      if (next.has(regionId)) {
        next.delete(regionId);
      } else {
        next.add(regionId);
      }
      return { expandedVpcGroups: next };
    }),

  vpcGroupViewMode: new Map(),
  toggleVpcGroupTable: (groupKey) =>
    set((state) => {
      const next = new Map(state.vpcGroupViewMode);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.set(groupKey, 'table');
      }
      return { vpcGroupViewMode: next };
    }),

  expandedTgwGroups: new Set(),
  toggleTgwGroup: (regionId) =>
    set((state) => {
      const next = new Set(state.expandedTgwGroups);
      if (next.has(regionId)) {
        next.delete(regionId);
      } else {
        next.add(regionId);
      }
      return { expandedTgwGroups: next };
    }),

  expandedPartnerGroups: new Set(),
  togglePartnerGroup: (groupKey) =>
    set((state) => {
      const next = new Set(state.expandedPartnerGroups);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return { expandedPartnerGroups: next };
    }),

  showNonDxVpcs: new Set(),
  toggleShowNonDxVpcs: (regionCode) =>
    set((state) => {
      const next = new Set(state.showNonDxVpcs);
      if (next.has(regionCode)) next.delete(regionCode);
      else next.add(regionCode);
      return { showNonDxVpcs: next };
    }),

  expandedIsolatedTgwGroups: new Set(),
  toggleIsolatedTgwGroup: (regionId) =>
    set((state) => {
      const next = new Set(state.expandedIsolatedTgwGroups);
      if (next.has(regionId)) {
        next.delete(regionId);
      } else {
        next.add(regionId);
      }
      return { expandedIsolatedTgwGroups: next };
    }),

  isolatedTgwGroupViewMode: new Map(),
  toggleIsolatedTgwGroupTable: (groupKey) =>
    set((state) => {
      const next = new Map(state.isolatedTgwGroupViewMode);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.set(groupKey, 'table');
      }
      return { isolatedTgwGroupViewMode: next };
    }),

  expandedTgwRoutePanels: new Set(),
  toggleTgwRoutePanel: (tgwId) =>
    set((state) => {
      const next = new Set(state.expandedTgwRoutePanels);
      if (next.has(tgwId)) next.delete(tgwId); else next.add(tgwId);
      return { expandedTgwRoutePanels: next };
    }),

  expandedVpcRoutePanels: new Set(),
  toggleVpcRoutePanel: (vpcId) =>
    set((state) => {
      const next = new Set(state.expandedVpcRoutePanels);
      if (next.has(vpcId)) next.delete(vpcId); else next.add(vpcId);
      return { expandedVpcRoutePanels: next };
    }),

  expandedVpcPeerPanels: new Set(),
  toggleVpcPeerPanel: (vpcId) =>
    set((state) => {
      const next = new Set(state.expandedVpcPeerPanels);
      if (next.has(vpcId)) next.delete(vpcId); else next.add(vpcId);
      return { expandedVpcPeerPanels: next };
    }),

  expandedCloudWanRoutePanels: new Set(),
  toggleCloudWanRoutePanel: (coreNetworkId) =>
    set((state) => {
      const next = new Set(state.expandedCloudWanRoutePanels);
      if (next.has(coreNetworkId)) next.delete(coreNetworkId); else next.add(coreNetworkId);
      return { expandedCloudWanRoutePanels: next };
    }),

  showVpcs: true,
  setShowVpcs: (show) => set({ showVpcs: show }),

  expandedUnattachedZone: false,
  toggleUnattachedZone: () => set((state) => ({ expandedUnattachedZone: !state.expandedUnattachedZone })),

  expandedHiddenAssocZone: false,
  toggleHiddenAssocZone: () => set((state) => ({ expandedHiddenAssocZone: !state.expandedHiddenAssocZone })),

  bedrockStatus: 'idle',
  setBedrockStatus: (status) => set({ bedrockStatus: status }),

  credentialsModalOpen: false,
  setCredentialsModalOpen: (open) => set({ credentialsModalOpen: open }),

  showLiveStatus: false,
  toggleLiveStatus: () => set((state) => ({ showLiveStatus: !state.showLiveStatus })),

  redactMode: loadRedactMode(),
  toggleRedactMode: () => set((state) => {
    const next = !state.redactMode;
    try { localStorage.setItem(REDACT_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return { redactMode: next };
  }),

  showUtilization: false,
  setShowUtilization: (show) => set({ showUtilization: show }),
  utilizationWindowDays: 30,
  setUtilizationWindowDays: (days) => set({ utilizationWindowDays: days }),
  utilizationLoading: false,
  utilizationError: null,
  utilizationCache: new Map(),
  loadUtilization: async (windowDays) => {
    const { credentials, useMock, topologyData, utilizationCache, importedSnapshot } = get();
    if (!topologyData) return;
    // Cache hit short-circuits everything else — applies to live fetches
    // (avoids re-billing CloudWatch), mock scenarios, and imported snapshots
    // (where the cache was rehydrated from the file). Must run before the
    // credentials gate so imported mode can flip windows without an AWS
    // round-trip.
    const cached = utilizationCache.get(windowDays);
    if (cached) {
      // Stamp the cached values back onto topologyData so the rebuild picks
      // them up — a fresh object reference is what the useEffect watches.
      const next: TopologyData = {
        ...topologyData,
        vifUtilization: cached.vif,
        connectionUtilization: cached.connection,
        utilizationWindowDays: windowDays,
      };
      set({
        topologyData: next,
        utilizationWindowDays: windowDays,
        utilizationLoading: false,
        utilizationError: null,
      });
      return;
    }
    // Mock topologies bake utilization into the fixture itself, so there's
    // nothing to fetch — just flip the toggle on.
    if (useMock) {
      set({
        utilizationLoading: false,
        utilizationError: null,
        utilizationWindowDays: windowDays,
      });
      return;
    }
    // In imported mode without a cached entry for this window, fail soft —
    // the customer didn't fetch this window before exporting, and the SA
    // has no credentials to fetch it now. Surface the gap clearly instead
    // of an opaque "Connect to AWS" message.
    if (importedSnapshot) {
      set({
        utilizationError: `No utilization data for ${windowDays}-day window in this snapshot`,
        utilizationLoading: false,
        utilizationWindowDays: windowDays,
      });
      return;
    }
    if (!credentials) {
      set({ utilizationError: 'Connect to AWS to fetch utilization', utilizationLoading: false });
      return;
    }
    set({ utilizationLoading: true, utilizationError: null });
    try {
      const result = await fetchUtilization(
        credentials,
        topologyData.virtualInterfaces,
        topologyData.connections,
        windowDays,
      );
      const nextCache = new Map(get().utilizationCache);
      nextCache.set(windowDays, result);
      const latestTopology = get().topologyData;
      if (!latestTopology) return;
      const next: TopologyData = {
        ...latestTopology,
        vifUtilization: result.vif,
        connectionUtilization: result.connection,
        utilizationWindowDays: windowDays,
      };
      set({
        topologyData: next,
        utilizationCache: nextCache,
        utilizationWindowDays: windowDays,
        utilizationLoading: false,
        utilizationError: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ utilizationLoading: false, utilizationError: msg });
    }
  },
  resetUtilization: () =>
    set({
      showUtilization: false,
      utilizationCache: new Map(),
      utilizationLoading: false,
      utilizationError: null,
    }),

  edgeLabelOffsets: new Map(),
  setEdgeLabelOffset: (edgeId, dx, dy) =>
    set((state) => {
      const next = new Map(state.edgeLabelOffsets);
      next.set(edgeId, { dx, dy });
      return { edgeLabelOffsets: next };
    }),

  // Node size overrides are in-memory only — browser refresh reverts the
  // resized Customer Data Center zone to its auto-computed layout size.
  nodeSizeOverrides: new Map<string, { width: number; height: number }>(),
  setNodeSizeOverride: (nodeId, width, height) =>
    set((state) => {
      const next = new Map(state.nodeSizeOverrides);
      next.set(nodeId, { width, height });
      return { nodeSizeOverrides: next };
    }),
  clearNodeSizeOverrides: () => {
    set({ nodeSizeOverrides: new Map() });
  },
  updateNodeDimensions: (changes) =>
    set((state) => {
      const updateList = (nodes: DxNode[]) => {
        let changed = false;
        const next = nodes.map((n) => {
          const ch = changes.find((c) => c.id === n.id);
          if (!ch) return n;
          changed = true;
          return {
            ...n,
            width: ch.width,
            height: ch.height,
            style: { ...n.style, width: ch.width, height: ch.height },
            data: { ...n.data, containerWidth: ch.width, containerHeight: ch.height },
          };
        });
        return changed ? next : nodes;
      };
      const currentNodes = updateList(state.currentNodes);
      const recommendedCurrentNodes = updateList(state.recommendedCurrentNodes);
      const patch: Partial<TopologyStore> = {};
      if (currentNodes !== state.currentNodes) patch.currentNodes = currentNodes;
      if (recommendedCurrentNodes !== state.recommendedCurrentNodes) patch.recommendedCurrentNodes = recommendedCurrentNodes;
      return patch;
    }),

  edgeReconnectOverrides: loadMapFromStorage<{ source: string; target: string }>(REWIRE_STORAGE_KEY),
  setEdgeReconnectOverride: (edgeId, source, target) =>
    set((state) => {
      const next = new Map(state.edgeReconnectOverrides);
      next.set(edgeId, { source, target });
      saveMapToStorage(REWIRE_STORAGE_KEY, next);
      return { edgeReconnectOverrides: next };
    }),
  clearEdgeReconnectOverrides: () => {
    try { localStorage.removeItem(REWIRE_STORAGE_KEY); } catch { /* ignore */ }
    set({ edgeReconnectOverrides: new Map() });
  },

  hiddenEdgeIds: loadSetFromStorage(HIDDEN_EDGES_KEY),
  hideEdge: (edgeId) =>
    set((state) => {
      const next = new Set(state.hiddenEdgeIds);
      next.add(edgeId);
      saveSetToStorage(HIDDEN_EDGES_KEY, next);
      return { hiddenEdgeIds: next };
    }),
  unhideEdge: (edgeId) =>
    set((state) => {
      const next = new Set(state.hiddenEdgeIds);
      next.delete(edgeId);
      saveSetToStorage(HIDDEN_EDGES_KEY, next);
      return { hiddenEdgeIds: next };
    }),
  clearHiddenEdges: () => {
    try { localStorage.removeItem(HIDDEN_EDGES_KEY); } catch { /* ignore */ }
    set({ hiddenEdgeIds: new Set() });
  },

  userEdges: (() => {
    try {
      const raw = localStorage.getItem(USER_EDGES_KEY);
      // Normalized on the way in: a link drawn by an older build comes back
      // without the `data` flags that build had not defined yet.
      if (raw) return normalizeUserEdges(JSON.parse(raw) as DxEdge[]);
    } catch { /* ignore */ }
    return [];
  })(),
  addUserEdge: (edge) =>
    set((state) => {
      const next = state.userEdges.some((e) => e.id === edge.id)
        ? state.userEdges
        : [...state.userEdges, edge];
      try { localStorage.setItem(USER_EDGES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      // Re-adding an edge with the same id should also un-hide it
      const patch: Partial<TopologyStore> = { userEdges: next };
      if (state.hiddenEdgeIds.has(edge.id)) {
        const hidden = new Set(state.hiddenEdgeIds);
        hidden.delete(edge.id);
        saveSetToStorage(HIDDEN_EDGES_KEY, hidden);
        patch.hiddenEdgeIds = hidden;
      }
      return patch;
    }),
  clearUserEdges: () => {
    try { localStorage.removeItem(USER_EDGES_KEY); } catch { /* ignore */ }
    set({ userEdges: [] });
  },

  userCustomerSites: (() => {
    try {
      const raw = localStorage.getItem(USER_CUSTOMER_SITES_KEY);
      if (raw) return JSON.parse(raw) as DxNode[];
    } catch { /* ignore */ }
    return [];
  })(),
  addUserCustomerSite: () =>
    set((state) => {
      const id = `user-custsite-${Date.now()}`;
      const newSite: DxNode = {
        id,
        type: 'customerSite',
        position: { x: 0, y: 0 }, // FlowCanvas positions it below existing sites
        data: {
          label: 'Customer Data Center',
          category: 'customerSite',
          details: { userCreated: 'true' },
        },
        style: { width: 260, height: 120 },
        width: 260,
        height: 120,
      };
      const next = [...state.userCustomerSites, newSite];
      try { localStorage.setItem(USER_CUSTOMER_SITES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userCustomerSites: next };
    }),
  removeUserCustomerSite: (id) =>
    set((state) => {
      const next = state.userCustomerSites.filter((s) => s.id !== id);
      try { localStorage.setItem(USER_CUSTOMER_SITES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userCustomerSites: next };
    }),
  updateUserCustomerSitePosition: (id, position) =>
    set((state) => {
      let changed = false;
      const next = state.userCustomerSites.map((s) => {
        if (s.id !== id) return s;
        changed = true;
        return { ...s, position, data: { ...s.data, userPlaced: 'true' } };
      });
      if (!changed) return {};
      try { localStorage.setItem(USER_CUSTOMER_SITES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userCustomerSites: next };
    }),
  updateUserCustomerSiteDimensions: (id, width, height) =>
    set((state) => {
      let changed = false;
      const next = state.userCustomerSites.map((s) => {
        if (s.id !== id) return s;
        changed = true;
        return {
          ...s,
          width,
          height,
          style: { ...s.style, width, height },
          data: { ...s.data, containerWidth: width, containerHeight: height },
        };
      });
      if (!changed) return {};
      try { localStorage.setItem(USER_CUSTOMER_SITES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userCustomerSites: next };
    }),
  clearUserCustomerSites: () => {
    try { localStorage.removeItem(USER_CUSTOMER_SITES_KEY); } catch { /* ignore */ }
    set({ userCustomerSites: [] });
  },

  hiddenCustomerSiteIds: loadSetFromStorage(HIDDEN_CUSTOMER_SITES_KEY),
  hideCustomerSite: (id) =>
    set((state) => {
      const next = new Set(state.hiddenCustomerSiteIds);
      next.add(id);
      saveSetToStorage(HIDDEN_CUSTOMER_SITES_KEY, next);
      return { hiddenCustomerSiteIds: next };
    }),
  unhideCustomerSite: (id) =>
    set((state) => {
      const next = new Set(state.hiddenCustomerSiteIds);
      next.delete(id);
      saveSetToStorage(HIDDEN_CUSTOMER_SITES_KEY, next);
      return { hiddenCustomerSiteIds: next };
    }),
  clearHiddenCustomerSites: () => {
    try { localStorage.removeItem(HIDDEN_CUSTOMER_SITES_KEY); } catch { /* ignore */ }
    set({ hiddenCustomerSiteIds: new Set() });
  },

  userOnPremises: (() => {
    try {
      const raw = localStorage.getItem(USER_ONPREMISES_KEY);
      if (raw) return JSON.parse(raw) as DxNode[];
    } catch { /* ignore */ }
    return [];
  })(),
  addUserOnPremise: (parentSiteId) =>
    set((state) => {
      const id = `user-onprem-${Date.now()}`;
      // FlowCanvas stacks user routers below the existing companion inside the
      // zone. We don't know the zone's size here, so seed with (0, 0) and let
      // FlowCanvas reposition on the next render — matches the userCustomerSite pattern.
      const newRouter: DxNode = {
        id,
        type: 'onPremise',
        parentId: parentSiteId,
        position: { x: 0, y: 0 },
        data: {
          label: 'Customer Router',
          category: 'onPremise',
          details: { userCreated: 'true', parentSiteId },
        },
      };
      const next = [...state.userOnPremises, newRouter];
      try { localStorage.setItem(USER_ONPREMISES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userOnPremises: next };
    }),
  removeUserOnPremise: (id) =>
    set((state) => {
      const next = state.userOnPremises.filter((r) => r.id !== id);
      try { localStorage.setItem(USER_ONPREMISES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userOnPremises: next };
    }),
  updateUserOnPremisePosition: (id, position) =>
    set((state) => {
      let changed = false;
      const next = state.userOnPremises.map((r) => {
        if (r.id !== id) return r;
        changed = true;
        return { ...r, position, data: { ...r.data, userPlaced: 'true' } };
      });
      if (!changed) return {};
      try { localStorage.setItem(USER_ONPREMISES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return { userOnPremises: next };
    }),

  hiddenOnPremiseIds: loadSetFromStorage(HIDDEN_ONPREMISES_KEY),
  hideOnPremise: (id) =>
    set((state) => {
      const next = new Set(state.hiddenOnPremiseIds);
      next.add(id);
      saveSetToStorage(HIDDEN_ONPREMISES_KEY, next);
      return { hiddenOnPremiseIds: next };
    }),
  unhideOnPremise: (id) =>
    set((state) => {
      const next = new Set(state.hiddenOnPremiseIds);
      next.delete(id);
      saveSetToStorage(HIDDEN_ONPREMISES_KEY, next);
      return { hiddenOnPremiseIds: next };
    }),
  clearHiddenOnPremises: () => {
    try { localStorage.removeItem(HIDDEN_ONPREMISES_KEY); } catch { /* ignore */ }
    set({ hiddenOnPremiseIds: new Set() });
  },

  reparentNodeToContainer: (nodeId, newParentId, relativePosition) =>
    set((state) => {
      const updateList = (nodes: DxNode[]) => {
        let changed = false;
        const next = nodes.map((n) => {
          if (n.id !== nodeId) return n;
          changed = true;
          return { ...n, parentId: newParentId, position: relativePosition };
        });
        return changed ? next : nodes;
      };
      const currentNodes = updateList(state.currentNodes);
      const recommendedCurrentNodes = updateList(state.recommendedCurrentNodes);
      const patch: Partial<TopologyStore> = {};
      if (currentNodes !== state.currentNodes) patch.currentNodes = currentNodes;
      if (recommendedCurrentNodes !== state.recommendedCurrentNodes) patch.recommendedCurrentNodes = recommendedCurrentNodes;
      return patch;
    }),

  isSimulating: false,
  setIsSimulating: (simulating) => set({
    isSimulating: simulating,
    ...(!simulating ? { failedNodeIds: new Set(), failedEdgeIds: new Set() } : {}),
  }),
  failedNodeIds: new Set(),
  failedEdgeIds: new Set(),
  toggleNodeFailure: (id) =>
    set((state) => {
      const next = new Set(state.failedNodeIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { failedNodeIds: next };
    }),
  toggleEdgeFailure: (id) =>
    set((state) => {
      const next = new Set(state.failedEdgeIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { failedEdgeIds: next };
    }),
  failZone: (nodeIds, edgeIds) =>
    set((state) => {
      const nextNodes = new Set(state.failedNodeIds);
      const nextEdges = new Set(state.failedEdgeIds);
      // If all nodes in the zone are already failed, unfail them (toggle)
      const allFailed = nodeIds.every((id) => nextNodes.has(id));
      if (allFailed) {
        for (const id of nodeIds) nextNodes.delete(id);
        for (const id of edgeIds) nextEdges.delete(id);
      } else {
        for (const id of nodeIds) nextNodes.add(id);
        for (const id of edgeIds) nextEdges.add(id);
      }
      return { failedNodeIds: nextNodes, failedEdgeIds: nextEdges };
    }),
  clearFailures: () => set({ failedNodeIds: new Set(), failedEdgeIds: new Set() }),

  homeAccountName: null,
  setHomeAccountName: (name) => set({ homeAccountName: name }),

  isLocked: true,
  setIsLocked: (locked) => set({ isLocked: locked }),

  hoveredNodeId: null,
  highlightedNodeIds: new Set(),
  highlightedEdgeIds: new Set(),
  pinnedNodeId: null,
  setHoveredNode: (id) =>
    set((state) => {
      // A pinned node freezes the highlight — hover in/out is a visual no-op
      // until the user explicitly unpins. Keeps the path readable while the
      // cursor wanders off to inspect details or read a side panel.
      if (state.pinnedNodeId != null) return {};
      if (id === state.hoveredNodeId) return {};
      if (id == null) {
        return { hoveredNodeId: null, highlightedNodeIds: new Set(), highlightedEdgeIds: new Set() };
      }
      const path = computePath(id, state);
      return {
        hoveredNodeId: id,
        highlightedNodeIds: path.nodes,
        highlightedEdgeIds: path.edges,
      };
    }),
  setHoveredEdge: (edgeId, source, target) =>
    set((state) => {
      // A pinned path takes precedence — same rule as setHoveredNode.
      if (state.pinnedNodeId != null) return {};
      if (edgeId == null) {
        if (state.hoveredNodeId == null) return {};
        return { hoveredNodeId: null, highlightedNodeIds: new Set(), highlightedEdgeIds: new Set() };
      }
      // hoveredNodeId is set (to a synthetic marker) purely so the dim-others
      // machinery in BaseNode/CustomEdge activates; the highlight sets below
      // scope what stays lit to just this edge and its two endpoints.
      const nodes = new Set<string>();
      if (source) nodes.add(source);
      if (target) nodes.add(target);
      return {
        hoveredNodeId: source ?? edgeId,
        highlightedNodeIds: nodes,
        highlightedEdgeIds: new Set([edgeId]),
      };
    }),
  setPinnedNode: (id) =>
    set((state) => {
      if (id == null) {
        if (state.pinnedNodeId == null) return {};
        return {
          pinnedNodeId: null,
          hoveredNodeId: null,
          highlightedNodeIds: new Set(),
          highlightedEdgeIds: new Set(),
        };
      }
      // Toggle off if clicking the already-pinned node.
      if (state.pinnedNodeId === id) {
        return {
          pinnedNodeId: null,
          hoveredNodeId: null,
          highlightedNodeIds: new Set(),
          highlightedEdgeIds: new Set(),
        };
      }
      const path = computePath(id, state);
      return {
        pinnedNodeId: id,
        hoveredNodeId: id,
        highlightedNodeIds: path.nodes,
        highlightedEdgeIds: path.edges,
      };
    }),
  spotlightNodeIds: new Set(),
  setSpotlightNode: (id) =>
    set((state) => {
      if (id == null) {
        return state.spotlightNodeIds.size === 0 ? {} : { spotlightNodeIds: new Set() };
      }
      if (state.spotlightNodeIds.size === 1 && state.spotlightNodeIds.has(id)) return {};
      return { spotlightNodeIds: new Set([id]) };
    }),
  setSpotlightNodes: (ids) =>
    set((state) => {
      const next = new Set(ids);
      if (next.size === state.spotlightNodeIds.size) {
        let same = true;
        for (const id of next) {
          if (!state.spotlightNodeIds.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return {};
      }
      return { spotlightNodeIds: next };
    }),

  spotlightEdgeIds: new Set(),
  setSpotlightEdge: (id) =>
    set((state) => {
      if (id == null) {
        return state.spotlightEdgeIds.size === 0 ? {} : { spotlightEdgeIds: new Set() };
      }
      if (state.spotlightEdgeIds.size === 1 && state.spotlightEdgeIds.has(id)) return {};
      return { spotlightEdgeIds: new Set([id]) };
    }),

  topologyRefreshNonce: 0,
  bumpTopologyRefresh: () => set((state) => ({ topologyRefreshNonce: state.topologyRefreshNonce + 1 })),

  importedSnapshot: null,
  loadSnapshot: (file) => {
    const topology = deserializeTopologyData(file.topology);
    const view = file.view;
    const cust = file.customizations;

    // Customer-customization localStorage keys are wiped first to avoid
    // stale references from the SA's prior view leaking into the imported
    // graph (mirrors setMockScenario).
    try { localStorage.removeItem(USER_EDGES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(HIDDEN_EDGES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(REWIRE_STORAGE_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(USER_CUSTOMER_SITES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(HIDDEN_CUSTOMER_SITES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(USER_ONPREMISES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(HIDDEN_ONPREMISES_KEY); } catch { /* ignore */ }

    // Persist the customer's customizations so they survive a browser refresh
    // while in imported mode (the SA may toggle redact, theme, etc. then
    // refresh — we don't want to lose the customer's user-drawn edges).
    if (cust.userEdges?.length) {
      try { localStorage.setItem(USER_EDGES_KEY, JSON.stringify(cust.userEdges)); } catch { /* ignore */ }
    }
    if (cust.userCustomerSites?.length) {
      try { localStorage.setItem(USER_CUSTOMER_SITES_KEY, JSON.stringify(cust.userCustomerSites)); } catch { /* ignore */ }
    }
    if (cust.userOnPremises?.length) {
      try { localStorage.setItem(USER_ONPREMISES_KEY, JSON.stringify(cust.userOnPremises)); } catch { /* ignore */ }
    }
    const hiddenEdgeIds = new Set(cust.hiddenEdgeIds ?? []);
    if (hiddenEdgeIds.size > 0) saveSetToStorage(HIDDEN_EDGES_KEY, hiddenEdgeIds);
    const hiddenCustomerSiteIds = new Set(cust.hiddenCustomerSiteIds ?? []);
    if (hiddenCustomerSiteIds.size > 0) saveSetToStorage(HIDDEN_CUSTOMER_SITES_KEY, hiddenCustomerSiteIds);
    const hiddenOnPremiseIds = new Set(cust.hiddenOnPremiseIds ?? []);
    if (hiddenOnPremiseIds.size > 0) saveSetToStorage(HIDDEN_ONPREMISES_KEY, hiddenOnPremiseIds);
    const edgeReconnectOverrides = new Map(cust.edgeReconnectOverrides ?? []);
    if (edgeReconnectOverrides.size > 0) saveMapToStorage(REWIRE_STORAGE_KEY, edgeReconnectOverrides);

    // Rehydrate the full utilization cache (every window the customer
    // fetched). Falls back to the active window's metrics on topologyData
    // for older snapshots that didn't ship the full cache. This lets the
    // SA flip 30/60/90 in imported mode without a CloudWatch fetch.
    const utilizationCache = new Map<30 | 60 | 90, { vif: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>; connection: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }> }>();
    if (view.utilizationCache && view.utilizationCache.length > 0) {
      for (const [window, entry] of view.utilizationCache) {
        utilizationCache.set(window, {
          vif: new Map(entry.vif),
          connection: new Map(entry.connection),
        });
      }
    } else if (topology.vifUtilization || topology.connectionUtilization) {
      const window = topology.utilizationWindowDays ?? view.utilizationWindowDays ?? 30;
      utilizationCache.set(window, {
        vif: topology.vifUtilization ?? new Map(),
        connection: topology.connectionUtilization ?? new Map(),
      });
    }

    // Stamp the active window's metrics onto topologyData so the first paint
    // shows utilization regardless of whether the customer had the toggle
    // on at export time. CustomEdge reads vifUtilization/connectionUtilization
    // through topology-builder, not directly from utilizationCache.
    const activeWindow = view.utilizationWindowDays ?? topology.utilizationWindowDays ?? 30;
    const active = utilizationCache.get(activeWindow);
    if (active && (active.vif.size > 0 || active.connection.size > 0)) {
      topology.vifUtilization = active.vif;
      topology.connectionUtilization = active.connection;
      topology.utilizationWindowDays = activeWindow;
    }

    // Persist redact-on across reloads while in imported mode — same reason
    // as the existing toggleRedactMode path.
    if (file.redactedView) {
      try { localStorage.setItem(REDACT_STORAGE_KEY, '1'); } catch { /* ignore */ }
    }

    // Order matters: write all view state and customizations into the store
    // before topologyData. useTopology.ts subscribes to topologyData last in
    // its dep list, so a single rebuild runs with the new view state already
    // in place — otherwise the first paint would use the SA's prior expanded
    // groups.
    set({
      // Force redact ON if the snapshot was sanitized — pseudo IDs are not
      // sensitive but we still want the SA's first impression to mirror the
      // customer's screen.
      ...(file.redactedView ? { redactMode: true } : {}),

      viewMode: view.viewMode,
      showLiveStatus: view.showLiveStatus,
      showUtilization: view.showUtilization,
      utilizationWindowDays: view.utilizationWindowDays,
      focusedDxGatewayId: view.focusedDxGatewayId,
      resiliencyTargets: { ...view.resiliencyTargets },

      expandedVpcGroups: new Set(view.expandedVpcGroups ?? []),
      expandedTgwGroups: new Set(view.expandedTgwGroups ?? []),
      expandedPartnerGroups: new Set(view.expandedPartnerGroups ?? []),
      expandedIsolatedTgwGroups: new Set(view.expandedIsolatedTgwGroups ?? []),
      expandedTgwRoutePanels: new Set(view.expandedTgwRoutePanels ?? []),
      expandedVpcRoutePanels: new Set(view.expandedVpcRoutePanels ?? []),
      expandedVpcPeerPanels: new Set(view.expandedVpcPeerPanels ?? []),
      expandedCloudWanRoutePanels: new Set(view.expandedCloudWanRoutePanels ?? []),
      vpcGroupViewMode: new Map(view.vpcGroupViewMode ?? []),
      isolatedTgwGroupViewMode: new Map(view.isolatedTgwGroupViewMode ?? []),
      showVpcs: view.showVpcs,
      showNonDxVpcs: new Set(view.showNonDxVpcs ?? []),
      expandedUnattachedZone: view.expandedUnattachedZone,
      expandedHiddenAssocZone: view.expandedHiddenAssocZone,

      userEdges: normalizeUserEdges(cust.userEdges ?? []),
      hiddenEdgeIds,
      edgeReconnectOverrides,
      userCustomerSites: cust.userCustomerSites ?? [],
      hiddenCustomerSiteIds,
      userOnPremises: cust.userOnPremises ?? [],
      hiddenOnPremiseIds,

      utilizationCache,
      utilizationLoading: false,
      utilizationError: null,

      // Clear loading / error from any prior fetch so the imported view
      // doesn't show a stale "Connection failed" overlay.
      isLoading: false,
      error: null,

      // Clobber any in-flight selection / simulation state from the SA's
      // prior session so the imported view loads clean.
      hoveredNodeId: null,
      pinnedNodeId: null,
      highlightedNodeIds: new Set(),
      highlightedEdgeIds: new Set(),
      spotlightNodeIds: new Set(),
      spotlightEdgeIds: new Set(),
      isSimulating: false,
      failedNodeIds: new Set(),
      failedEdgeIds: new Set(),

      topologyData: topology,

      importedSnapshot: {
        exportedAt: file.exportedAt,
        appVersion: file.appVersion,
        redactedView: file.redactedView,
        customerNote: file.customerNote,
      },
    });
  },
  clearImportedSnapshot: () => {
    set({
      importedSnapshot: null,
      topologyData: null,
      currentNodes: [],
      currentEdges: [],
      recommendedNodes: [],
      recommendedEdges: [],
      recommendedCurrentNodes: [],
      assessment: null,
      utilizationCache: new Map(),
    });
  },
}));

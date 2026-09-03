# Visualization & UI Reference

Detailed documentation for the network diagram visualization, layout engine, interactive features, and UI components.

## Table of Contents

1. [Network Components Visualized](#1-network-components-visualized)
   - [1.1 Containment Hierarchy](#11-containment-hierarchy)
   - [1.2 Node Information](#12-node-information)
   - [1.3 Edge Types](#13-edge-types)
   - [1.4 VPC Collapsing](#14-vpc-collapsing)
   - [1.5 TGW Collapsing](#15-tgw-collapsing)
   - [1.6 Unattached Resources Zone](#16-unattached-resources-zone)
   - [1.7 Route Table Panels](#17-route-table-panels)
   - [1.8 Layout Engine](#18-layout-engine)
2. [View Modes](#2-view-modes)
3. [Per-DX-Gateway Recommendation Focus](#3-per-dx-gateway-recommendation-focus)
4. [Topology Editing](#4-topology-editing)
5. [Edge Label Dragging](#5-edge-label-dragging)
6. [Live Status Layer](#6-live-status-layer)
   - [6.4 Utilization Bar](#64-utilization-bar-vif-and-dx-connection-edges)
   - [6.5 BGP Routes](#65-bgp-routes)
   - [6.6 DXGW Route Diff](#66-dxgw-route-diff--cross-vif-prefix-comparison)
7. [Canvas Lock](#7-canvas-lock)
8. [Failure Simulation](#8-failure-simulation)
9. [Dark / Light Theme](#9-dark--light-theme)

## 1. Network Components Visualized

### 1.1 Containment Hierarchy

The diagram uses nested, draggable containers. Dragging a container moves everything inside it. Use the **lock button** in the top-left controls to freeze all dragging — see [Canvas Lock](#7-canvas-lock).

```
AWS Cloud (outermost)
├── Direct Connect Gateway(s)
├── Cloud WAN Core Network(s)
└── Region(s)
    ├── Transit Gateway(s) or collapsed TGW Group
    ├── Virtual Private Gateway(s)
    └── VPC(s) or collapsed VPC Group

DX Location (separate container, outside AWS Cloud)
├── Partner/Customer Device
└── AWS Device

Customer Site (separate container)
└── Customer Gateway
```

### 1.2 Node Information

Every node displays an icon, a friendly name, a subtitle, a resource ID, and key properties. The friendly name is resolved from the AWS **Name tag** first, then the resource **name** field, then a descriptive fallback.

| Component | Key Info Shown |
|---|---|
| Customer Gateway | Customer ASN, IP address, number of connections |
| VPN Connection | VPN type, state, category, tunnel count (up/total), ASN |
| Partner / Customer Device | Connection ID, connection state, location code |
| AWS Device | Connection ID, connection state, logical device ID, ASN |
| DX Gateway | Gateway ID, Amazon-side ASN, gateway state |
| Core Network | Core Network ID, state, segments, edge locations |
| Transit Gateway | TGW ID, ASN, state, region |
| Virtual Private Gateway | VGW ID, ASN, state |
| VPC | VPC ID, CIDR block, state |
| Collapsed TGW Group | Count of TGWs (e.g., "5 TGWs") — click to expand |
| Collapsed VPC Group | Count of VPCs (e.g., "8 VPCs") — click to expand |

### 1.3 Edge Types

| Edge | Between | Data Shown |
|---|---|---|
| **Physical link** | Customer Gateway → Partner / Customer Device | (no label) — **user-drawn**; not auto-rendered |
| **Customer Link** | Customer Gateway ↔ Customer Gateway, or Partner / Customer Device ↔ Partner / Customer Device | (no label, same as the physical link) — **user-drawn**; not auto-rendered. Joins two customer-owned devices of the *same* kind. Routes bottom→top between them, and is point-to-point like a peering (hovering highlights the pair, not both devices' full end-to-end paths). Because the cable is bidirectional, it hangs off the end-to-end path rather than extending it: clicking or hovering **any** node on either device's path covers the link and lights up the device at the far end, but stops there rather than pulling that device's own path in |
| **DX Connection** | Partner / Customer Device → AWS Device | Connection name, connection ID, bandwidth, connection state |
| **VIF** | AWS Device → DX Gateway or VGW | VIF type (Private/Transit/Public), VLAN ID, VIF ID, VIF state*, BGP status* |
| **DX GW Association** | DX Gateway → TGW or VGW | Allowed prefix CIDRs, association state* |
| **VPN Tunnel** | VPN Connection → TGW or VGW | VPN name, per-tunnel UP/DOWN status* |
| **Cloud WAN Peering** | Core Network → TGW | Segment name |
| **TGW Peering** | TGW → TGW (cross-region) | Peering name |
| **VPC Peering** | VPC → VPC (same/cross-region, same/cross-account) | Peering name, peering connection ID, state* — drawn from each VPC's right-side handle, smoothstep path detours around region containers |
| **Recommended** | Any gap | Dashed green — suggested resiliency improvement |

\* Only visible when **Live Status** toggle is ON (see [Live Status Layer](#6-live-status-layer))

**Naming note** — the two customer-owned node kinds are easy to mix up, because the names in this table are not the subtitles printed on the cards:

| This table calls it | The card's subtitle reads | Where it sits |
|---|---|---|
| Customer Gateway | **Customer Router** | Customer Site container |
| Partner / Customer Device | **Customer Gateway** | DX Location container |

Both can be linked to others of their own kind, and both offer the same top/bottom handles for it.

All existing edges are solid purple bezier curves with animated flow dots. Recommended edges are dashed green.

### 1.4 VPC Collapsing

When a region has 4 or more VPCs attached to a Transit Gateway, they automatically collapse into a single `VpcGroupNode` showing a count badge (e.g., "8 VPCs"). Clicking the collapsed node expands to show individual VPCs. Threshold: `LAYOUT.vpcCollapseThreshold` in `utils/constants.ts` (default 4).

### 1.5 TGW Collapsing

When a region has 3 or more Transit Gateways, they automatically collapse into a single `TgwGroupNode` showing a count badge (e.g., "5 TGWs"). Clicking the collapsed node expands to show individual TGWs. When TGWs are collapsed, their associated VPCs are also hidden. Threshold: `LAYOUT.tgwCollapseThreshold` in `utils/constants.ts` (default 3).

### 1.6 Unattached Resources Zone

A single **Unattached resources** container sits at the bottom of the AWS Cloud, collapsed by default. It holds inline tables for resources that exist in the account but aren't wired into any DX path:

| Section | Criteria |
|---|---|
| **Unattached DX Gateways** | DXGW has no VIFs AND no TGW/VGW associations |
| **Unattached VGWs** | VGW has no DX Gateway association AND no `"attached"`-state VPC attachment |
| **Isolated VPCs** | VPC has no TGW, VGW, or Cloud WAN attachment |
| **Isolated TGWs** | TGW has no VPC, VPN, peering, DX Gateway, or TGW Connect attachment |

The expanded zone shows each section as its own inline table with resource IDs, ASNs, states, and cross-account owner where applicable. For Isolated TGWs, a secondary **Expand** button breaks them out as individual canvas nodes.

### 1.7 Route Table Panels

**Transit Gateway** and **VPC** nodes, and **VIF edges**, each expose an inline route viewer. Panels are draggable and scrollable, and track their anchor as the canvas pans and zooms.

| Panel | Trigger | Source API | Contents |
|---|---|---|---|
| **TGW route table** | Click a Transit Gateway node | `DescribeTransitGatewayRouteTables` + `SearchTransitGatewayRoutes` | Route table name, default-association flag, and per-route destination CIDR, attachment target, type (static / propagated), state |
| **VPC route table** | Click the **Routes ▾** toggle on a VPC node (only shown when the VPC has route tables) | `DescribeRouteTables` | Route table ID, main-table flag, associated subnet IDs, and per-route destination (CIDR / IPv6 / prefix list), target (IGW, NAT GW, TGW, VPC peering, ENI, etc.), origin (static / propagated), state |
| **VIF BGP routes** | Click the **Routes ▾** toggle on a VIF edge label (shown in live mode, which is what fetches the routes) | `ListVirtualInterfaceRoutes` | Accepted / Advertised tabs with counts, then a filter box and the same columns the DX console shows: **prefix**, **route age** (from `routeInstalledAt`), **address family**, **AS path** (chips joined by →, AS_SET members in braces), and **communities**. Documented DX community tags are decoded inline (e.g. `7224:7300 High return-path preference`); unrecognized values render raw. Sort toggles between prefix and age (oldest first). An IPv4/IPv6 filter appears only when both families are present. The filter box doubles as an **IP lookup** — see below |
| **DXGW route diff** | Click **Route diff** on a Direct Connect Gateway node (live mode, gateway has ≥2 VIFs; its `⚠ N` count is already on the button) | none — reuses the `ListVirtualInterfaceRoutes` data above | A **check-mark matrix** with one column per VIF and one row per prefix, marking exact / covering / partial / absent. The tab bar (**ALL** + one per VIF) is multi-select: one tab narrows the rows, two or more narrow the comparison itself and highlight those VIFs' edges on the canvas. See §6.6 |

Blackhole routes are highlighted in red in the TGW and VPC panels. The VPC panel requires `ec2:DescribeRouteTables`; the VIF BGP and DXGW route-diff panels require `directconnect:ListVirtualInterfaceRoutes` (both granted in the `DxVisualizerCore` IAM statement).

Because a VIF is an **edge**, not a node, `VifRoutePanel` cannot resolve its position via `getNode()` and a parent-chain walk the way `TgwRoutePanel` does — `CustomEdge` passes down the flow-space coordinates of its own label instead, and the panel applies the viewport transform. On an aggregated multi-VIF edge, expanding **Show all VIFs** gives each member VIF its own **Routes** button, since the aggregate edge's `vifId` is synthetic.

**IP lookup in the BGP filter box.** Typing a complete address or block (`10.20.5.7`, `10.20.5.7/24`, `2001:db8::1`) switches the filter from substring matching to range matching via `utils/cidr.ts`, so an address finds the prefixes that *carry* it — `10.20.5.7` is not a substring of `10.20.0.0/16`, so text matching alone returned nothing. Matching is by **overlap**, so it reads both ways: a host address surfaces every covering prefix, and a block surfaces the more-specifics inside it. A summary line above the table names the **longest matching prefix** — the one that actually wins forwarding — and that row is outlined in teal. When no route on the current tab covers the address, the line says so and points at the other tab if that side covers it (the asymmetry operators usually chase). Misses caused by the v4/v6 tab are called out as such rather than reported as a routing gap.

Anything that isn't a complete address — a partial prefix like `10.20`, an ASN, a community like `7224:7100` — parses to `null` and keeps the original substring behaviour, so the two modes never collide. Both families run through `BigInt` in one code path, and family mismatches never match (a v6 lookup can't return v4 rows). Matching runs on real values while redact mode masks the display, including the echoed query, so a redacted screenshot stays redacted.

### 1.8 Layout Engine

The layout engine uses a fully dynamic, column-based approach with no hardcoded pixel positions:

- **Multi-column layout**: Nodes are assigned to columns by their category (On-Premise -> Partner / Customer Device -> AWS Device -> DX Gateway -> Core Network -> Customer Gateway -> TGW/VGW -> VPC)
- **Dynamic spacing**: Column gaps and row gaps are computed as ratios of actual node dimensions
- **DX Location grouping**: Nodes within the same DX location are grouped and enclosed in a container
- **VPN separation**: VPN connection paths are laid out in a separate section above DX connection paths
- **Crossing minimization**: A permutation-based optimizer tries all orderings for columns with <=7 nodes to find the arrangement with minimum edge crossings
- **Container auto-sizing**: DX Location and Region containers compute their bounds from their children with configurable padding
- **Parent/child grouping**: Uses React Flow's native `parentId` for container-child relationships (AWS Cloud → Region → TGW/VPC, DX Location → devices, Customer Site → on-premise). Dragging a container moves all children automatically.
- **Multi-region offset**: Regions connected by direct inter-region edges (e.g. TGW peering) are shifted horizontally to create smoother diagonal edge flows
- **Depth-sorted rendering**: Nodes are sorted by nesting depth (root → mid-level → leaf) so React Flow renders parents before children

## 2. View Modes

| Mode | What's Shown |
|------|-------------|
| **Current State** | Existing infrastructure with solid purple edges and animated flow dots. |
| **Recommended** | Everything from Current State, plus green dashed ghost nodes and edges showing suggested resiliency improvements to reach the next tier. |

## 3. Per-DX-Gateway Recommendation Focus

When multiple DX Gateways exist, each gateway's row in the Resilience Status card shows upgrade-option buttons (High / Maximum). Clicking one focuses the canvas on that gateway's recommendation overlay — it sets the target tier, focuses the gateway, and switches to the recommended view — and other DXGWs' ghosts are hidden until you click **View all** in the top bar. Each gateway's "add a second location" ghost zone also carries its own tier picker, but that picker only sets the gateway's target tier; it does not change canvas focus. Useful for walking through upgrade plans one DXGW at a time without visual clutter.

## 4. Topology Editing

The canvas supports a small set of in-place edits that persist in `localStorage`. These edits only affect the local view — they never mutate AWS.

| Edit | How |
|------|-----|
| **Add Customer Data Center** | Click the `+` button in any existing Customer Site container header. A new empty zone appears on the left edge, stacked below existing sites. |
| **Remove added Customer Data Center** | Click the `×` button in a user-added zone's header. Only user-added zones expose this affordance — AWS-discovered sites cannot be removed. |
| **Drag / resize added Customer Data Center** | Once the canvas is unlocked, drag the header to move it or use the corner handles to resize. User-added zones override layout-engine placement. |
| **Draw Customer Gateway → Partner Device cable** | Drag from a Customer Gateway's right handle to a Partner / Customer Device's left handle. This edge is no longer auto-drawn — the user is responsible for modeling how their on-prem routers cable to the partner demarc. |
| **Draw a Customer Link** | Drag between any two Customer Gateways (an HA pair inside one data center, or two sites), or between any two Partner / Customer Devices (the customer's own kit across two DX locations). Neither AWS nor the DX APIs report customer-side cabling, so a resiliency reader otherwise cannot tell devices that back each other up from two single points of failure side by side. Both node kinds carry a handle on their top and bottom edge; any handle works as the start, because the edge is always re-anchored bottom→top with the upper device as the source, and drawing it again the other way round is a no-op rather than a second overlapping edge. Mixing the two kinds gives the cross-connect above, not a link. Like the cross-connect, the link is drawn unlabelled — hover the line itself for the point-to-point highlight. |
| **Remove a cable** | Hover any user-drawn edge — a cross-connect or a Customer Link — to reveal an `×` above the midpoint, or click the edge and press **Delete** / **Backspace**. Only user-drawn edges expose either affordance; AWS-reported edges cannot be removed. Hidden edges render as dim dashed lines so you can still see where they used to be. |

**Reset behavior**: Switching mock scenarios or refreshing live AWS topology wipes all user edits — node IDs change across fetches, so any persisted customizations would render as stray references.

## 5. Edge Label Dragging

Edge labels can be dragged to reposition them for better readability. Drag offsets persist in memory until the topology is refreshed. Dragging is disabled while the canvas is locked (see [Canvas Lock](#7-canvas-lock)).

## 6. Live Status Layer

The **Live Status** toggle (heartbeat icon in the top bar) controls whether operational status information is shown on the diagram. This keeps the topology view clean by default while allowing operators to inspect health when needed.

### 6.1 What Changes When Live Status is ON

| Element | When Live Status is ON | When Live Status is OFF |
|---------|----------------------|------------------------|
| **VIF edges** | Show VIF state, BGP status, accepted/advertised prefix counts. With **Show utilization** also toggled on, add 30/60/90-day peak ingress/egress bps with a percent-of-port-capacity bar | Show only VIF type and VLAN ID |
| **DX Connection edges** | Show connection state with color coding. With **Show utilization** also on, add 30/60/90-day peak ingress/egress bps (aggregated from per-VIF CloudWatch streams) and a percent-of-port-capacity bar | Show connection name and bandwidth only |
| **DX GW → TGW/VGW edges** | Show association state with colored indicator | Show allowed prefixes only |
| **VPN Tunnel edges** | Show per-tunnel UP/DOWN status with colored dots | Show VPN name only |
| **VPN Connection nodes** | Show VPN state with colored dot | Show VPN connection info only |
| **Edge stroke color** | Green for healthy, red for down/failed | Standard purple/themed coloring |
| **Edge label borders/icons** | Remain default purple (not affected by status) | Default purple |

### 6.2 Three-Tier Status Colors

Status indicators on edges use a three-tier color system to distinguish between healthy, transitional, and failed states:

| Color | Meaning | States |
|-------|---------|--------|
| **Green** `#22c55e` | Healthy / Active | `available`, `associated`, `up`, `active` |
| **Amber** `#f59e0b` | Transitional / In Progress | `ordering`, `requested`, `pending`, `allocated`, `associating`, `updating`, `confirming`, `verifying`, `provisioning`, `initiating-request`, `pending-acceptance` |
| **Red** `#ef4444` | Down / Failed | `down`, `deleted`, `rejected`, `disassociated`, `unknown`, or any unrecognized state |

This ensures operators can distinguish between actual failures (red) and resources that are still being provisioned (amber), avoiding false alarms.

### 6.3 Edge Stroke vs Label Behavior

In live status mode, only the **edge stroke** (the line itself) changes color to reflect status. The edge **label borders**, **icons**, and **header text** remain in their default purple color. This keeps labels readable while still providing a clear visual signal on the connection lines.

### 6.4 Utilization Bar (VIF and DX Connection edges)

When the user enables **Show utilization** in the Live overlay (with a 30 / 60 / 90 day window), CloudWatch returns the **peak hourly bps** observed over the window for each VIF and aggregated by `ConnectionId` for each DX connection. The edge label then adds an ingress/egress row plus a horizontal capacity bar. The bar fill is the **peak of ingress and egress**, expressed as a percentage of the VIF's **effective ceiling**, and is coloured by threshold:

| Threshold | Colour |
|-----------|--------|
| < 50% of port capacity | Teal (healthy headroom) |
| 50% – 80% | Amber (watch) |
| > 80% | Red (capacity at risk) |

If the capacity is unknown, the bar is hidden and only the raw bps numbers are shown.

**The effective ceiling is the VIF's `rateLimit` when it has one, otherwise the parent connection's bandwidth.** A VIF rate limit (`DescribeVirtualInterfaces.rateLimit`, e.g. `50Mbps`) caps that VIF below its port, so measuring against the port badly under-reports: a saturated 50Mbps VIF on a 10Gbps port reads as **0.5%**, and the amber/red thresholds can never fire. The caption and tooltip name which ceiling is in use, since the two are very different denominators. The code takes `min(rateLimit, portBandwidth)` defensively — AWS guarantees a rate limit cannot exceed its port, but trusting the larger value would under-report.

Percentages **can exceed 100%**: rate limits shape traffic while CloudWatch reports what actually flowed, averaged over a different window. The bar clamps at 100% but the number is shown as-is rather than capped, because "155% of a 200Mbps limit" is the actionable signal.

On an **aggregated** multi-VIF edge the utilization is the sum across members, so the ceiling is the sum of their rate limits — but only when *every* member is capped. One uncapped member can use the whole port, so the port remains the real ceiling.

### 6.5 BGP Routes

BGP route visibility lives **inside** the live-status layer — it is the drill-down of the prefix-count row (§6.1), so there is no separate overlay toggle in the top bar. With Live Status ON, every VIF edge with a BGP session shows a **Routes ▾** button on its label, opening the actual prefixes exchanged on that VIF (§1.7).

Turning Live Status on is what fetches them: two paginated `ListVirtualInterfaceRoutes` calls per VIF (one per direction), for every VIF, cached for the lifetime of the topology. That fetch used to be deferred to the first **Routes** click so enabling Live stayed free — it moved because the DX Gateway's `⚠ N` failover-gap count (§6.6) is derived from this data, and a warning only visible *after* you open the panel that explains it is a warning nobody gets. The calls are read-only `List*` with no per-request charge. Every button click afterwards is a pure cache read, and the buttons still trigger the fetch themselves if the automatic one was skipped or is still running. While in flight the buttons show a spinner; if the fetch fails or returns nothing (most often a missing `directconnect:ListVirtualInterfaceRoutes` permission) they turn red/amber and their tooltip carries the reason rather than opening an empty panel — and the automatic path does **not** retry a failed attempt, so a missing permission costs one burst of AccessDenied per topology, not one per toggle. Reloading the topology clears the cache (it is keyed by VIF id, so it must not survive an account or scenario change) and refetches if Live is on.

Leaving Live Status closes any open route panels but keeps the fetched routes cached.

Beyond display, route data upgrades four best-practice rules from guidance to real detection — prefix-set consistency and summarization across redundant VIFs, unintended default routes, and cross-VIF prefix overlaps. See `docs/RECOMMENDATION-COVERAGE.md` §2.2. Without route data (toggle off, permission denied, mock scenario, or a v1 snapshot) those rules fall back to guidance or stay silent — they never assert a finding they can't evidence.

Route data is the most sensitive slice the app holds: real on-premises prefixes and customer ASNs. Redact mode masks CIDRs, AS-path ASNs, and community ASNs in the panel, and the snapshot sanitizer rewrites all three (leaving `0.0.0.0/0` and `::/0` intact so default-route semantics survive). Snapshot export does **not** auto-fetch routes the way it does utilization — they ship only if the customer actually fetched them.

The panel deliberately shows every field the API returns, matching the DX console's own BGP routes table. Note that AWS withholds its **internal** communities from `ListVirtualInterfaceRoutes`, so a route can legitimately show no communities; the panel states this in a footer rather than implying the route is untagged. The community decodings come from the [DX routing policies and BGP communities](https://docs.aws.amazon.com/directconnect/latest/UserGuide/routing-and-bgp.html) guide — local-preference tags (`7224:7100/7200/7300`) apply to private and transit VIFs, scope tags (`7224:9100/9200/9300`) to public VIFs, and `7224:8100/8200` are applied *by AWS* to routes it advertises. Don't invent meanings for other values: unrecognized communities render raw.

### 6.6 DXGW Route Diff — cross-VIF prefix comparison

The per-VIF panel above answers "what is on this VIF?". The **Route diff** button on a Direct Connect Gateway node answers the redundancy question the `consistent-prefix-advertisement` rule raises but cannot fit in a sentence: *which prefixes on this gateway have no backup path?* It is the interactive counterpart to that finding, and the finding's remediation text points at it.

Zero new API calls — `computeDxgwRouteDiff` (`engine/vif-route-diff.ts`) is pure and reads the same `topology.vifRoutes` the live layer fetches. It is gated on Live Status because that is where the data comes from, not because it costs anything itself.

**The count comes before the click.** As soon as routes are in (which is now part of turning Live Status on, §6.5), the button carries `⚠ N` — the number of distinct prefixes on the gateway with a gap in their failover coverage, whether that gap is total (no sibling reaches any of the block) or partial (siblings carry only pieces of it) — or `✓` when every prefix is fully backed up. The two kinds are summed here and split apart inside the panel, where the remediation differs. This is the whole reason the fetch moved onto the Live toggle: while it was deferred to this button's own click, the count only existed for someone who had already decided to go looking, and the panel is the *explanation* of a finding the button is supposed to raise. While the fetch is in flight the button shows a spinner; if it was skipped or failed the tooltip says so. The button only appears when the gateway has **two or more** VIFs: a single-VIF gateway has nothing to compare, and the resiliency rules already flag it as a single point of failure in its own right. After a fetch, it also disappears if fewer than two of those VIFs actually returned routes — the comparison is then genuinely unavailable, not merely unfetched.

Inside is a matrix with **one column per VIF on the gateway** and one row per distinct prefix. The tabs — **ALL** plus one per VIF, numbered and badged — choose which VIFs are in play; they never change the columns. A 4-VIF gateway therefore has 4 columns and 5 tabs, and the table keeps its shape on every click. **ALL** is the default and lists the union of every prefix on the gateway, so a prefix present on only one VIF is visible without hunting for the right tab; a single VIF tab narrows to that VIF's own prefixes to answer "what happens to *my* routes if I go away?".

**Comparing a subset.** The tab bar is **multi-select**, and its meaning scales with the count: nothing selected is the gateway-wide view, one tab filters the rows to that VIF while grading stays gateway-wide, and **two or more narrows the comparison to just those VIFs** — "if I lose one of *these two*, does the other cover me?". The strip directly beneath the tabs names whichever stage you are in, and `× clear` restores the full gateway. Four consequences:

- **One selector, not two.** The comparison used to be a second control: the numbered **column headers** picked the subset while the tabs filtered rows. The two jobs really are different, but the second selector was a row of bare numerals beside the word `Prefix` — it read as a static column label, so the whole feature was undiscoverable, which is worse than one gesture whose meaning scales. Reusing the tabs also means the selector is the element that already carries each VIF's name, badge, and ID. The trade-off given up: you can no longer show *only* VIF 1's rows while comparing 1 against 3 — a pair shows the union of both VIFs' prefixes, and the `✓` marks say which side owns each one.
- **The subset is regraded, not merely filtered.** `computeDxgwRouteDiff` takes an optional set of VIF IDs and applies the *same* rule to whichever VIFs are in scope, so a prefix that reads `redundant` gateway-wide correctly reads `solo` inside a pair that excludes its other carrier. That gap is the entire reason for narrowing — scoping the columns while keeping gateway-wide verdicts would show a prefix marked safe next to a single `✓`. Row ranking is unchanged, so a newly solo prefix rises to the top exactly as it does on **ALL**.
- **Out-of-scope columns stay on screen, dimmed.** They keep their true gateway-wide mark (a bare `·` would falsely read as "cannot reach"), and column numbers are assigned over the whole gateway *before* narrowing, so "column 3" means the same VIF between clicks. The headers are labels; a dimmed VIF is re-added from **its own tab**, which stays clickable and is where the reader is already looking.
- **The canvas follows the selection.** The selected VIF IDs go into the store (`routeDiffPickedVifIds`), and `CustomEdge` draws a purple halo on any edge whose own `vifId` — or any member of its `aggregatedVifs`, since a bundled edge carries a synthetic id — is in that set. Keyed by VIF rather than edge id for that reason. A lone selection is lit too: the tab bar means "which VIFs are in play", and one in play is worth pointing at on the canvas. Closing the panel or clearing the selection drops the highlight: lit edges with no panel to explain them read as a rendering bug.

Cell marks:

| Mark | Meaning |
|---|---|
| **✓** | That VIF accepts the prefix itself. Two or more `✓` on a row is like-for-like redundancy |
| **~** | It has no such prefix but does carry a **less specific** one that contains it. Failover works, at coarser granularity; the tooltip names the covering route |
| **◐** | It carries only **more specific** prefixes *inside* the block. Part of the range fails over and part does not; the tooltip names the pieces it does carry (capped at 6) |
| **·** | It cannot reach any part of the prefix |

Six design points that are easy to get wrong:

- **Columns are numbered, not named.** VIF names on one gateway routinely share both a prefix and a suffix (`cwnm-poc-primary-x` vs `cwnm-poc-secondary-x`), so no fixed-width abbreviation stays unambiguous. The tab bar carries the full names and doubles as the legend; every cell has a tooltip naming the peer in full.
- **A tab names the VIF, and shows its VIF ID to prove it.** The label is `virtualInterfaceName` (falling back to the VIF ID) — never the connection name. That distinction is invisible from the name alone on a **hosted-VIF account**: `fetch-topology.ts` names an *inferred* connection after the VIF that revealed it, so the identical string appears on the DX Connection edge label and here. Each tab therefore prints the `dxvif-…` ID beside the name (suppressed when the VIF is unnamed and the two are the same string), and tab and column tooltips read `VIF <name> (<vifId>, <type>) on connection <connectionId>`.
- **A warning is "carried by only one VIF", not "missing from some VIF".** On a gateway serving several distinct sites, almost every prefix is absent from some VIF — flagging those would bury the real finding. A prefix on 2 of 6 VIFs has a backup path and is not flagged.
- **Tabs scope rows; columns are fixed.** An earlier version showed one selected VIF's prefixes against N-1 *peer* columns, which meant a 4-VIF gateway rendered only 3 columns and the column set changed on every tab click — the reader had to re-learn the table each time, and a prefix absent from the selected VIF was invisible entirely. Including each VIF's own column costs one glyph per row and makes the ownership of a prefix readable directly. This holds when the tabs narrow a comparison too: out-of-scope columns dim rather than disappear.
- **`◐` exists because the aggregate-vs-components shape is common and both simpler answers are wrong.** One VIF advertises a `/16` while its sibling advertises the individual `/24`s: calling that `·` claims traffic is blackholed when most of it still flows, and calling it `~` hides that everything outside those `/24`s has no path. The demo topology is exactly this — collapsing `◐` into `·` overstated its unprotected count as 7 when 5 prefixes are truly orphaned and 2 (a `/16` aggregate and a default route) are partly covered. A row is only **solo** when *no* peer reaches *any* part of it; full coverage on one peer still beats fragments on another, so `~` wins over `◐` on the same cell.
- **A row is graded once, over whatever is in scope.** The verdict (`solo` / `partial` / `covered` / `redundant`) is a property of the prefix, not of which tab is highlighted, so a prefix reads the same on **ALL** as on a single VIF tab — one selected tab filters rows without changing any verdict. Only selecting two or more re-scopes the grading, and then it re-grades every row alike. Tab badges count that VIF's *own* flagged prefixes, and they do sum to the ALL badge: a `solo` or `partial` row has exactly one owning VIF by definition, so it is badged on exactly one tab.

Rows are ranked no-other-path → partly-covered → all-carriers-on-one-device → all-carriers-in-one-site → covered-only-by-a-less-specific → carried by 2+ VIFs, then by prefix; the `⚠ first` toggle switches to plain prefix order. Only **accepted** routes are compared: advertised routes come from the gateway association's `allowedPrefixes`, which is per-association, so every VIF on one DXGW draws from the same set by construction and comparing them can only surface BGP convergence noise. The footer says so, and also warns that a prefix missing from a sibling can be intentional traffic engineering.

Rows carry a **`#` index column** so a gateway with 40 prefixes can be discussed out loud — "row 12" is usable in a call in a way a `/26` read digit by digit is not.

#### Address lookup

The filter box does double duty. A term that parses as a **complete** address or block becomes a **range lookup**; anything else — a partial prefix mid-typing, a stray digit — falls through to plain substring matching. Substring matching alone cannot answer the question an operator actually has: `100.0.0.1` is not a substring of `100.0.0.0/24`, so typing a host address used to report "no prefixes match" for an address the gateway demonstrably carries. The lookup reads **both ways** — a host address finds every prefix containing it, and a block finds the more specific prefixes inside it — and because overlapping prefixes are normal on a gateway (an aggregate plus its components) and forwarding takes the longest match, a summary line names the winning prefix rather than leaving the reader to work it out. It is measured over the in-scope rows with the family filter applied, so it can never name a row the table is hiding.

**Both the `#` and `Prefix` column widths are measured over the gateway-wide row set, never over what is currently on screen.** The matrix is flex-based rather than a `<table>`, so columns align to the header by width alone; sizing them off filtered data made the panel resize under the cursor — typing two characters dropped the long prefixes from view, the column shrank to fit what was left, and every matrix column jumped mid-keystroke. The gateway-wide set is a superset of any tab subset and of any filtered view, so it is the widest the column ever needs to be and it does not move while the reader narrows. The shared-fate chip allowance is reserved on the same basis, so hiding the last chipped row does not reclaim its space.

#### Shared fate — ⚡ one device, ⚑ one site

Two or more `✓` on a row means the prefix has more than one path. It does not mean it has more than one *thing that can take every path away*. When every VIF carrying a prefix terminates on the same AWS logical device, or in the same DX location, the row is marked with an amber chip beside the prefix: **`⚡ 1 device`** or **`⚑ 1 site`**. A `⚡` row survives nothing — the next scheduled maintenance on that device takes the prefix out entirely; a `⚑` row survives device maintenance but not a site event.

Free to compute: `awsLogicalDeviceId` and `location` already arrive on `DescribeVirtualInterfaces`, so this is no new API call and no new IAM action, and `computeDxgwRouteDiff` stays pure.

- **Only already-safe verdicts are graded.** `gradeFate` runs on `redundant` and `covered` rows only. A `solo` row has one carrier by definition, so "all its carriers share a device" is trivially true and says nothing the `⚠` does not already say louder.
- **Tightest scope only.** A device is inside a site, so carriers on one device are also in one site; reporting both would double-count one problem. The chip names the narrower fact.
- **An unknown domain is never reported as shared.** A VIF with no `awsLogicalDeviceId` (or no location) makes the answer unknown, not affirmative, and grading it as shared would invent a finding.
- **It ranks above `covered`.** A `covered` row still reaches its destination today; a single-device row loses the prefix outright the next time AWS takes that device down. Fate is therefore checked before the verdict, since a `covered` row can carry a chip too.
- **The counts do not sum across tabs, unlike `⚠`.** A shared-fate row has two or more carriers by definition, so each carrier's own tab legitimately counts it. A `solo` or `partial` row has exactly one owner, which is why those badges do sum. This asymmetry is intentional and the summary strip states the counts separately.
- **Ticks stay green on a chipped row.** An amber `✓` was tried and removed: a fate is only reported when *every* carrier shares one domain, so every in-scope tick on a flagged row was amber — a row-level fact repainted onto each data cell, already carried by the chip (which names the domain), the amber prefix text, the row wash and the row outline. It also lied on a narrowed comparison, where a dimmed out-of-scope column kept a green tick beside amber siblings and read as "that one is safe" when it only meant "not in this comparison". The per-cell tooltip still names the shared domain, which genuinely is per column.

Both chips are amber, not red, and deliberately weaker than `⚠`: the prefix does have a second path. The claim is only that the second path shares a failure domain with the first.

## 7. Canvas Lock

The lock button (bottom of the top-left controls panel) freezes the diagram layout so you can browse without accidentally moving anything.

| State | Behavior |
|-------|----------|
| **Unlocked** (default) | Nodes, containers, and edge labels can be freely dragged to rearrange the layout |
| **Locked** | All dragging is disabled — nodes, containers, and edge labels stay in place. Panning and zooming still work so you can navigate the diagram. |

When locked, failure simulation clicks (edge and zone failures) are also disabled.

## 8. Failure Simulation

The visualizer includes a **failure simulation mode** that lets you test the resilience of your topology by simulating failures at different levels. Toggle simulation mode from the top bar.

### 8.1 How It Works

When simulation mode is active:

- **Edge failures**: Click any connection edge to toggle it as failed (turns red and dashed, and its animated flow dot is removed). This simulates a single link going down.
- **Zone failures**: Each DX Location, AWS Region, and Customer Site container displays a lightning bolt button. Clicking it fails **all child nodes and their connected edges** within that zone — simulating a full site or region outage.
- **Toggle behavior**: Clicking a failed zone or edge again restores it to normal. If all children in a zone are already failed, clicking the zone button restores them all.

### 8.2 What Turns Red

| Element | Visual Change When Failed |
|---------|--------------------------|
| **Edges** | Turn red and dashed; the animated flow dot is removed |
| **Individual nodes** | Red border and red background tint, plus a static red X overlay |
| **Zone containers** | Red border, red background tint, and red header |

### 8.3 Simulation Scope

- Only **existing infrastructure** can be failed — recommended (ghost) nodes and edges are excluded from simulation
- Zone failure cascades to all non-container child nodes within the zone boundary, plus all edges connected to those child nodes
- The simulation is purely visual and stateful — it does not affect any AWS resources

## 9. Dark / Light Theme

Toggle between dark and light themes from the overflow (three-dots) menu in the top bar — open the menu and choose Light mode / Dark mode. The theme affects all UI elements including the canvas background, node styling, edge colors, chat panel, and Resilience Status card.

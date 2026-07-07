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
| **DX Connection** | Partner / Customer Device → AWS Device | Connection name, connection ID, bandwidth, connection state |
| **VIF** | AWS Device → DX Gateway or VGW | VIF type (Private/Transit/Public), VLAN ID, VIF ID, VIF state*, BGP status* |
| **DX GW Association** | DX Gateway → TGW or VGW | Allowed prefix CIDRs, association state* |
| **VPN Tunnel** | VPN Connection → TGW or VGW | VPN name, per-tunnel UP/DOWN status* |
| **Cloud WAN Peering** | Core Network → TGW | Segment name |
| **TGW Peering** | TGW → TGW (cross-region) | Peering name |
| **VPC Peering** | VPC → VPC (same/cross-region, same/cross-account) | Peering name, peering connection ID, state* — drawn from each VPC's right-side handle, smoothstep path detours around region containers |
| **Recommended** | Any gap | Dashed green — suggested resiliency improvement |

\* Only visible when **Live Status** toggle is ON (see [Live Status Layer](#6-live-status-layer))

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

Both **Transit Gateway** and **VPC** nodes expose an inline route table viewer. The panel is draggable, scrollable, and follows its parent node as the canvas pans.

| Panel | Trigger | Source API | Contents |
|---|---|---|---|
| **TGW route table** | Click a Transit Gateway node | `DescribeTransitGatewayRouteTables` + `SearchTransitGatewayRoutes` | Route table name, default-association flag, and per-route destination CIDR, attachment target, type (static / propagated), state |
| **VPC route table** | Click the **Routes ▾** toggle on a VPC node (only shown when the VPC has route tables) | `DescribeRouteTables` | Route table ID, main-table flag, associated subnet IDs, and per-route destination (CIDR / IPv6 / prefix list), target (IGW, NAT GW, TGW, VPC peering, ENI, etc.), origin (static / propagated), state |

Blackhole routes are highlighted in red in both panels. The VPC panel requires the `ec2:DescribeRouteTables` permission (granted in the `DxVisualizerCore` IAM statement).

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
| **Remove a cable** | Hover a Customer Gateway → Partner Device edge to reveal an `×` above the midpoint, or click the edge and press **Delete** / **Backspace**. Hidden edges render as dim dashed lines so you can still see where they used to be. |

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

When the user enables **Show utilization** in the Live overlay (with a 30 / 60 / 90 day window), CloudWatch returns the **peak hourly bps** observed over the window for each VIF and aggregated by `ConnectionId` for each DX connection. The edge label then adds an ingress/egress row plus a horizontal capacity bar. The bar fill is the **peak of ingress and egress**, expressed as a percentage of the underlying connection bandwidth, and is coloured by threshold:

| Threshold | Colour |
|-----------|--------|
| < 50% of port capacity | Teal (healthy headroom) |
| 50% – 80% | Amber (watch) |
| > 80% | Red (capacity at risk) |

If the connection bandwidth is unknown, the bar is hidden and only the raw bps numbers are shown.

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

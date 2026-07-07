# Recommendation Engine

Full reference for the two rule sets the Resilience Agent runs against a discovered topology, and how each rule is evaluated.

The recommendation system has **two independent categories**:

1. **Resiliency recommendations** — analyze the topology *structure* and suggest **new infrastructure** to add. In the **Recommended** view these render as **green dashed ghost nodes and edges** overlaid on the existing diagram. Resiliency rules run **per DX Gateway** — each DXGW is assessed independently against its own target tier, so accounts with multiple DXGWs get one set of ghost overlays per gateway.
2. **Best practice checks** — operational and configuration findings surfaced with a severity, shown in the Resilience Status checklist and (for faults) as colored edges in Live Status mode.

## 1. Resiliency rules

| Rule ID | Trigger | Recommendation | Signal |
|---|---|---|---|
| `single-dx-location` | Only 1 DX location serves this DX Gateway | Add a second DX location (ghost labels include the DXGW name when multiple gateways exist) | `DescribeLocations` + `DescribeConnections` grouping |
| `single-connection-per-location` | Any DX location has only 1 connection | Add a redundant DX connection at that location | `awsLogicalDeviceId` from `DescribeConnections` |
| `no-tgw` | No TGWs exist but VGWs do | Consider migrating to Transit Gateway | `DescribeTransitGateways` |
| `single-vgw` | Exactly 1 VGW and no TGWs | Add a redundant VPN Gateway | `DescribeVpnGateways` |
| `no-lag` | 2+ connections at a location but no LAGs | Consider using LAGs to bundle connections | `DescribeLags` |
| `pubvif-single-dx-location` | Public VIFs terminate at only 1 DX location | Add a second DX location for public VIF connectivity | `DescribeVirtualInterfaces` (public VIFs) + `DescribeConnections` grouping — only runs when public VIFs exist |
| `pubvif-single-connection-per-location` | A public-VIF DX location has connections on only 1 device (Maximum target only) | Add a redundant connection on a separate device | `awsLogicalDeviceId` from `DescribeConnections` — only runs when public VIFs exist |

The two `pubvif-*` rules run through a dedicated public-VIF assessment path and only apply when the topology has public virtual interfaces; their ghost overlays attach to the **public-endpoints** node rather than a DX Gateway.

## 2. Best practice rules

Unlike the resiliency rules above (which are all evaluated against observed AWS data), best-practice checks vary in whether they can be verified automatically. The key question is **where the data lives**: AWS's APIs only expose AWS's side of the connection, so a rule can be checked automatically only if the thing it verifies is visible through an AWS API or CloudWatch metric. Many best practices are not — they depend on state that lives on **your own equipment or processes**: the on-premise router / customer gateway (BFD, BGP hold timers, advertised prefixes, Dead Peer Detection), your AWS Support plan, or your team's runbooks. AWS has no API for those, so the agent can't detect them; it can only remind you to check.

The **Detection** column in the tables below tells you which kind each rule is:

| Value | What it means | Does it depend on your account state? | Example |
|---|---|---|---|
| **API-supported** | The rule reads live state from an AWS API (SDK) or a CloudWatch metric and flags an issue based on what it finds. | Yes — it only flags a real, observed problem. | `vif-down` is flagged only when a VIF's BGP session is actually down, read from `DescribeVirtualInterfaces`. |
| **Partial** | The rule detects the AWS-side half of the setting via API, but the customer-premise half is not exposed, so a clean result is an attestation you should still verify. | Partly — the AWS side is observed; the on-prem side is not. | `vpn-dpd` reads the AWS tunnel's DPD action, but can't see the Dead Peer Detection config on your customer gateway. |
| **Guidance** | The rule always appears when it's relevant to your topology shape. AWS doesn't expose the underlying state, so it's an informational reminder or attestation, not a detected fault. | No — it is always shown, regardless of the actual setting. | `bfd-guidance` always recommends enabling BFD, because BFD runs on your router and AWS has no visibility into it. |

### 2.1 Architecture

Rules related to topology design, redundancy strategy, and structural decisions.

| Rule ID | Detection | Check | Signal / Notes |
|---|---|---|---|
| `no-vpn-backup` | API-supported | DX without a Site-to-Site VPN backup path | Topology correlation between DX + `DescribeVpnConnections` |
| `cgw-redundancy` | API-supported | All VPN connections terminate on a single Customer Gateway — deploy 2+ CGWs to avoid a device-level SPOF | `DescribeCustomerGateways` + VPN assignment |
| `dx-partner-diversity` | API-supported | All DX connections come from the same partner / last-mile provider | `DescribeConnections` — `partnerName` |
| `cross-region-path` | API-supported | Resources exist in regions with no local DX termination — cross-region hops aren't covered by the DX SLA | Region comparison across DXGW associations + attachments |
| `enterprise-support-required` | Guidance | SLA precondition: Enterprise Support for the 99.9% / 99.99% tiers | Cannot query the Support plan from these APIs — attestation-only when target tier is High/Maximum |
| `well-architected-review-required` | Guidance | SLA precondition: a Well-Architected Review for the 99.99% tier | Cannot query WA Review state — attestation-only |
| `dx-location-redundancy` | Guidance | Metro vs geographic DX location diversity trade-off | Risk-profile recommendation — always informational |
| `sla-awareness` | Guidance | Reminder of the three published DX SLA tiers (95% / 99.9% / 99.99%) and what each requires | Informational prompt based on current shape |
| `resiliency-toolkit` | Guidance | Pointer to the AWS DX Resiliency Toolkit for production workloads | Informational |

### 2.2 Configuration

Rules related to BGP/BFD settings, connection state, and protocol tuning.

| Rule ID | Detection | Check | Signal / Notes |
|---|---|---|---|
| `vif-down` | API-supported | VIF BGP session not established | `DescribeVirtualInterfaces` — `virtualInterfaceState` + `bgpPeers[].bgpStatus`; shown as a red edge in Live Status mode |
| `connection-not-available` | API-supported | DX connection in a non-`available` state | `DescribeConnections` — `connectionState`; shown as a red edge in Live Status mode |
| `vpn-tunnel-redundancy` | API-supported | Both tunnels UP per Site-to-Site VPN — flag any VPN with fewer than both up | `DescribeVpnConnections` — `vgwTelemetry[].status` |
| `bgp-route-limit` | API-supported | ≤100 prefixes on-prem → AWS on private/transit VIFs | CloudWatch `AWS/DX` `VirtualInterfaceBgpPrefixesAccepted` (IPv4 + IPv6 summed). Escalates by observed prefix count: **Critical** at 100+ (per-session hard limit — session at risk of teardown), **Warning** within 20 of the limit (80+), **Info** within limits or when the metric stream is unavailable (e.g. brand-new VIF) |
| `vpn-dpd` | Partial | Dead Peer Detection action configured on VPN tunnels | AWS-side DPD action (`DpdTimeoutAction` from `DescribeVpnConnections` → `TunnelOptions`) is detected — **Warning** when any tunnel is set to `none` (switch to clear/restart); otherwise **Info**, an attestation that the customer-gateway-side DPD config (not exposed via API) is in place |
| `bfd-guidance` | Guidance | Enable BFD on the customer router for sub-second failover detection | BFD runs on the CPE; no AWS-side visibility |
| `bgp-timers-fallback` | Guidance | If BFD isn't supported, tune the BGP hold timer down from the 90s default | BGP timers live on the CPE |
| `consistent-prefix-advertisement` | Guidance | Advertise the same prefixes across redundant VIFs to avoid failover blackholes | BGP RIB isn't exposed — verify on the CPE |

### 2.3 Operations

Rules related to monitoring, testing, and runbook maintenance.

| Rule ID | Detection | Check | Signal / Notes |
|---|---|---|---|
| `dx-failover-testing` | Guidance | Schedule regular failover tests — AWS supports temporarily shutting down BGP peers for up to 72h via `StartBgpFailoverTest` | Operational process recommendation |
| `failover-runbooks` | Guidance | Maintain documented DX/VPN failover runbooks with escalation paths | Process recommendation |

## 3. How each rule is sourced

Every rule encodes an AWS-documented best practice from:

1. **[AWS Direct Connect Resiliency Toolkit](https://docs.aws.amazon.com/directconnect/latest/UserGuide/resilency_toolkit.html)**
2. **[AWS Well-Architected Framework — Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)**
3. **[AWS Direct Connect Best Practices](https://docs.aws.amazon.com/directconnect/latest/UserGuide/best-practices.html)**

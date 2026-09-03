# Best Practices Coverage

How each rule in the Resilience Agent is evaluated: detected automatically via AWS API / CloudWatch, partially detected, or surfaced as guidance because AWS does not expose the underlying state.

Legend:
- **Detected** — rule pulls state from AWS (SDK or CloudWatch) and flags an issue based on what it finds.
- **Partial** — rule uses API data for scoping but still relies on the operator to verify a non-API property.
- **Guidance** — rule always appears when the topology shape makes it relevant; state cannot be observed from AWS.

## Resiliency rules (generate ghost nodes for the target topology)

| Rule ID | Check | Detection | Signal |
|---|---|---|---|
| `single-dx-location` | Single DX location is a metro-scale SPOF | Detected | `DescribeLocations` + `DescribeConnections` grouping |
| `single-connection-per-location` | Only one AWS logical device per location | Detected | `awsLogicalDeviceId` from `DescribeConnections` |
| `no-tgw` | No Transit Gateway for scalable VPC attachment | Detected | `DescribeTransitGateways` |
| `single-vgw` | Reliance on a single VGW | Detected | `DescribeVpnGateways` |
| `no-lag` | No Link Aggregation Group | Detected | `DescribeLags` |

## Best practice rules — Architecture

Rules related to topology design, redundancy strategy, and structural decisions.

| Rule ID | Check | Detection | Signal / Notes |
|---|---|---|---|
| `no-vpn-backup` | DX without a Site-to-Site VPN backup | Detected | Topology correlation between DX + `DescribeVpnConnections` |
| `cgw-redundancy` | ≥2 customer gateways for device redundancy | Detected | `DescribeCustomerGateways` + VPN assignment |
| `dx-partner-diversity` | Multiple DX partners to avoid partner-level SPOF | Detected | `DescribeConnections` — `partnerName` |
| `cross-region-path` | DX region differs from attached VPC/TGW region | Detected | Region comparison across DXGW associations + attachments |
| `enterprise-support-required` | SLA precondition: Enterprise Support for 99.9%/99.99% tiers | Guidance | Cannot query Support plan from these APIs — attestation-only when target tier is High/Maximum |
| `well-architected-review-required` | SLA precondition: WA Review for 99.99% tier | Guidance | Cannot query WA Review state — attestation-only |
| `dx-location-redundancy` | Metro vs geographic DX location diversity | Guidance | Risk-profile recommendation — always informational |
| `sla-awareness` | Surface the 99.9%/99.99% tier model to the user | Guidance | Informational prompt based on current shape |
| `resiliency-toolkit` | Recommend AWS DX Resiliency Toolkit | Guidance | Informational |

## Best practice rules — Configuration

Rules related to BGP/BFD settings, connection state, and protocol tuning.

| Rule ID | Check | Detection | Signal / Notes |
|---|---|---|---|
| `vif-down` | VIF or all BGP peers in down state | Detected | `DescribeVirtualInterfaces` — `virtualInterfaceState` + `bgpPeers[].bgpStatus` |
| `connection-not-available` | DX connection in non-`available` state | Detected | `DescribeConnections` — `connectionState` |
| `vpn-tunnel-redundancy` | Both tunnels UP per S2S VPN | Detected | `DescribeVpnConnections` — `vgwTelemetry[].status` |
| `bgp-route-limit` | ≤100 prefixes on-prem → AWS on private/transit VIFs | Detected | Exact accepted-route count from `ListVirtualInterfaceRoutes` when available, else CloudWatch `AWS/DX` `VirtualInterfaceBgpPrefixesAccepted` (IPv4 + IPv6 summed). Falls back to guidance only when neither source has data (e.g. brand-new VIF) |
| `vif-rate-limit-oversubscription` | VIF rate limits sum above the parent port | Detected | `rateLimit` per VIF vs connection `bandwidth`; silent when no VIF is rate-limited |
| `bfd-guidance` | Enable BFD on customer router for sub-second failover | Guidance | BFD runs on the CPE; no AWS-side visibility |
| `bgp-timers-fallback` | Tune BGP hold timers when BFD unavailable | Guidance | BGP timers live on the CPE |
| `vpn-dpd` | Configure Dead Peer Detection on CPE | Guidance | DPD timer is a CPE-side config; not in any AWS API |
| `consistent-prefix-advertisement` | Same accepted prefixes across redundant VIFs | Detected with route data, else Guidance | Compares accepted prefix sets per DXGW/VGW from `ListVirtualInterfaceRoutes`. Needs `directconnect:ListVirtualInterfaceRoutes`; without it, guidance ("verify on CPE") |
| `vif-route-symmetry` | Summarize prefixes; keep VIF routing symmetric | Detected with route data, else Guidance | Flags prefixes already covered by a less-specific prefix on the same VIF |

## Best practice rules — Operations

Rules related to monitoring, testing, and runbook maintenance.

| Rule ID | Check | Detection | Signal / Notes |
|---|---|---|---|
| `dx-failover-testing` | Exercise failover via `StartBgpFailoverTest` on a schedule | Guidance | Operational process recommendation |
| `failover-runbooks` | Maintain documented failover runbooks | Guidance | Process recommendation |

## Summary

- **Detected (actionable from AWS data):** 14 rules — 5 resiliency + `vif-down`, `connection-not-available`, `vpn-tunnel-redundancy`, `no-vpn-backup`, `cgw-redundancy`, `dx-partner-diversity`, `cross-region-path`, `bgp-route-limit`, `vif-rate-limit-oversubscription`.
- **Detected only with BGP route data:** 2 rules — `consistent-prefix-advertisement` and `vif-route-symmetry`, which degrade to guidance without it. Both require `directconnect:ListVirtualInterfaceRoutes`, which is **not** covered by `directconnect:Describe*`.
- **Guidance (always informational):** 10 rules — the BFD / DPD / BGP-timer CPE-side configs, SLA preconditions (Enterprise Support, WA Review), and operational process recommendations (runbooks, failover testing, toolkit, SLA awareness, DX location strategy).

## Why guidance rules stay guidance

Several checks can't be detected even in principle from an AWS-side console:
- **CPE-side config** (BFD, DPD, BGP hold timers, advertised prefixes): these run on the customer router; AWS only sees the resulting session state, not the configuration.
- **Support plan / Well-Architected Review:** required for the published DX SLA tiers but not exposed on the DX or Support APIs in a way the topology fetcher can read.
- **Operational process** (runbooks, scheduled failover testing, partner coordination): no AWS resource represents these.

If AWS adds an API for any of these (e.g. a future `DescribeBgpSessionConfig`), promote the corresponding rule from "Guidance" to "Detected" following the same pattern `ruleBgpRouteLimit` now uses.

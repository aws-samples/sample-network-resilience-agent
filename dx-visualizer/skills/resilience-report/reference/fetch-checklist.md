# AWS CLI fetch checklist

Every call below is read-only. Run with `--output json`. Fail soft — log to "Data gaps", continue.

## Phase 1 — Identity & primary region

| # | Command | Used for |
|---|---|---|
| 1 | `aws sts get-caller-identity` | Account ID for filename + report header. Abort if this fails. |
| 2 | `aws iam list-account-aliases` | Optional friendly name in header. Skip on AccessDenied. |

## Phase 2 — Global APIs (any region; use the user's primary)

| # | Command | Feeds |
|---|---|---|
| 3 | `aws directconnect describe-direct-connect-gateways` | DXGW inventory, per-DXGW assessment cards |
| 4 | `aws directconnect describe-direct-connect-gateway-associations --direct-connect-gateway-id <id>` (per DXGW from #3) | `cross-region-path` rule, region discovery |
| 5 | `aws networkmanager list-core-networks` | Cloud WAN section (skip if denied — Cloud WAN is optional) |
| 6 | `aws networkmanager list-attachments` | Cloud WAN attachment list, region discovery |
| 7 | `aws networkmanager list-peerings` | Cloud WAN peering edges in diagram |

## Phase 3 — Region discovery

Build the region set from:
- The user's primary region
- Every `associatedGateway.region` returned by #4
- Every `edgeLocation` referenced by #5/#6

## Phase 4 — Per-region (run for each region from Phase 3, in parallel)

| # | Command | Feeds |
|---|---|---|
| 8 | `aws directconnect describe-connections --region <r>` | Inventory table; `connection-not-available`, `single-dx-location`, `dx-partner-diversity` |
| 9 | `aws directconnect describe-virtual-interfaces --region <r>` | Edge labels; `vif-down`, `single-connection-per-location`, `bgp-route-limit` scoping |
| 10 | `aws directconnect describe-lags --region <r>` | LAG inventory; `no-lag` |
| 11 | `aws directconnect describe-locations --region <r>` | Friendly location names in diagram |
| 12 | `aws ec2 describe-vpcs --region <r>` | VPC nodes in diagram |
| 13 | `aws ec2 describe-vpn-gateways --region <r>` | VGW nodes; `single-vgw` |
| 14 | `aws ec2 describe-transit-gateways --region <r>` | TGW nodes; `no-tgw` |
| 15 | `aws ec2 describe-transit-gateway-attachments --region <r>` | TGW→VPC/VPN edges, cross-account VPC discovery (`resourceOwnerId`) |
| 16 | `aws ec2 describe-transit-gateway-peering-attachments --region <r>` | TGW↔TGW edges |
| 17 | `aws ec2 describe-vpn-connections --region <r>` | VPN edges, both tunnel statuses (`vgwTelemetry[].status`); `vpn-tunnel-redundancy`, `no-vpn-backup` |
| 18 | `aws ec2 describe-customer-gateways --region <r>` | CGW nodes; `cgw-redundancy` |

## Phase 5 — CloudWatch metrics (only for resources in scope)

Use a single `aws cloudwatch get-metric-data` call per region with up to 500 `MetricDataQueries`. Window: now − 30 days → now. Period: 3600. Stat: `Maximum` for bps, `Average` for prefixes.

| Namespace / metric | Dimension | Used for |
|---|---|---|
| `AWS/DX` `VirtualInterfaceBgpPrefixesAccepted` | `VirtualInterfaceId` | `bgp-route-limit` (sum IPv4+IPv6 if both reported) |
| `AWS/DX` `VirtualInterfaceBgpPrefixesAdvertised` | `VirtualInterfaceId` | Inventory table |
| `AWS/DX` `VirtualInterfaceBpsIngress` | `VirtualInterfaceId` | Edge labels, top-5 utilization |
| `AWS/DX` `VirtualInterfaceBpsEgress` | `VirtualInterfaceId` | Edge labels, top-5 utilization |
| `AWS/DX` `ConnectionBpsIngress` | `ConnectionId` | Connection edges, top-5 utilization |
| `AWS/DX` `ConnectionBpsEgress` | `ConnectionId` | Connection edges, top-5 utilization |

If a metric returns no datapoints: render "—" in the table and demote `bgp-route-limit` to Guidance for that VIF.

## Phase 6 — Optional

| # | Command | Feeds |
|---|---|---|
| 19 | `aws health describe-events --filter services=DIRECTCONNECT --region us-east-1` | "Active maintenance" callout. Requires Business/Enterprise Support — skip silently on subscription error. |

## Partner-hosted accounts

If the account has VIFs but no owned connections returned by #8, infer a connection record per unique `connectionId` from #9 with `partnerName: 'Hosted'`, `connectionState: 'available'` (best-effort), and the bandwidth from the VIF. Note in "Data gaps" that connection metadata was inferred.

# Network Resilience Agent — Feature List

AWS Direct Connect topology visualiser and resiliency advisor. Everything below was verified against
the source code, not taken from documentation.

**Contents**

1. [Automatic discovery](#1-automatic-discovery)
2. [Visualisation](#2-visualisation)
3. [Resiliency assessment (SLA tiers)](#3-resiliency-assessment-sla-tiers)
4. [Recommendations drawn on the diagram](#4-recommendations-drawn-on-the-diagram)
5. [Best practices — three pillars](#5-best-practices--three-pillars)
6. [Route assessment (BGP)](#6-route-assessment-bgp)
7. [Live status and telemetry](#7-live-status-and-telemetry)
8. [AWS Health / maintenance calendar](#8-aws-health--maintenance-calendar)
9. [AI chat assistant](#9-ai-chat-assistant)
10. [Failure simulation and canvas editing](#10-failure-simulation-and-canvas-editing)
11. [Sharing, reporting and data protection](#11-sharing-reporting-and-data-protection)
12. [Security, deployment and demo](#12-security-deployment-and-demo)

---

## 1. Automatic discovery

- Sign in once and the tool maps your whole hybrid network by itself — no agent, no CloudFormation
  template, no inventory spreadsheet from the customer.
- Finds Direct Connect connections, virtual interfaces, LAGs, DX Gateways and their associations,
  Transit Gateways, VGWs, VPCs, Site-to-Site VPNs and customer gateways, Cloud WAN core networks,
  VPC peerings, and the AWS DX facility catalogue.
- Works out which regions to look in on its own (four independent sources unioned) — the user never
  picks a region.
- Handles partner-hosted VIFs, where the account owns no connection record: the physical path is
  reconstructed from the VIF and clearly marked as inferred.
- Finds VPCs owned by *other* accounts from Transit Gateway attachment metadata — no AWS
  Organizations permission needed. Optional role-assumption into spoke accounts fills in their real
  names and CIDRs.
- Everything is read-only: 40 distinct AWS read calls across 10 services, and no mutating API call
  exists anywhere in the codebase.
- If one permission is missing, that piece goes quiet and the rest of the diagram still renders — a
  denied call never blanks the screen.

## 2. Visualisation

- One interactive diagram of the full path: customer router → colo device → LAG → AWS router → DX
  Gateway / Cloud WAN → TGW or VGW → VPCs, plus public endpoints. 23 purpose-built node types.
- Layout is fully automatic — columns adapt to the estate, and edge crossings are minimised. Nothing
  is hardcoded in pixels.
- Edge labels carry the facts (VIF ID, VLAN, BGP ASN, bandwidth). Crowded areas collapse: many VIFs
  into one expandable edge, many VPCs/TGWs into group cards.
- Two "attention zones" surface things that would otherwise float unnoticed: unattached resources,
  and DX Gateway associations AWS has redacted from your account.
- Hover any node or edge to light up its entire end-to-end path; click to pin it.
- Full light and dark themes, minimap, auto-fit, zoom, collapsible legend, and a guided tour.
- Site-to-Site VPN can be hidden from the canvas (Layers panel) without affecting the assessment.

## 3. Resiliency assessment (SLA tiers)

- Grades the topology against AWS's published DX SLA tiers: No Resiliency, Development & Testing
  (95%), High (99.9%), Maximum (99.99%). Redundancy is counted in *distinct AWS routers*, so two
  circuits on the same AWS device correctly count as one.
- Graded independently per DX Gateway, per DX-reached VGW, per LAG, and for public VIFs — not one
  blanket verdict for the account.
- You pick the target tier (per gateway, or in bulk), and the gap to that target is what gets
  reported.
- Detects when two DX Gateways already back each other up (shared downstream), so it doesn't demand
  redundancy you already have.
- **Deliberately no numeric score** — the output is tiers plus met/unmet checklists. A single number
  invites arguing with the number instead of fixing the gap.
- 12 resiliency recommendations (from 9 rules) propose specific new infrastructure: second DX
  location, second connection on a separate AWS router, LAG bundling, add a TGW, etc. — always
  preferring to reuse a location you're already in.

## 4. Recommendations drawn on the diagram

- Recommended infrastructure appears as green dashed "ghost" nodes overlaid on your real purple
  topology, so the fix is visual rather than a paragraph.
- Ghost paths mirror the shape and size of the real path they duplicate.
- Focus one gateway's recommendation, or view all at once.

## 5. Best practices — three pillars

Grouped into **Architecture / Configuration / Operations** drawers, sorted critical → warning → info
→ met. 26 checks producing 30 findings:

| Pillar | Checks |
|--------|--------|
| **Architecture** | DX location redundancy; partner diversity (naming the actual alternative partners at your sites); VPN backup for DX; customer gateway redundancy; DX Gateway propagation into TGW route tables |
| **Configuration** | BFD enablement (and BGP hold-timer tuning where BFD isn't available); LAG minimum links; VIF rate-limit oversubscription; BGP prefix quota against the 100-per-address-family limit; prefix consistency across redundant VIFs; route summarisation; blackhole routes in TGW and VPC route tables; VPCs with no route back to on-premises; VPN static-routes-only; VPN DPD; VPN tunnel redundancy |
| **Operations** | VIF/BGP down and connection-not-available (observed faults); BGP session flap history; failover-test history; failover runbooks; resiliency toolkit awareness; plus two attestations AWS exposes no API for (Enterprise Support in place, Well-Architected review done), shown only when your target tier requires them |

Severity is three-level, and critical is reserved for things that are actually broken right now — not
for tier gaps, which may be a deliberate business decision.

## 6. Route assessment (BGP)

- **Per-VIF route panel** — the real accepted and advertised prefixes on the wire, with AS-path
  rendering, BGP community decoding, filters, sorting, and an IP/CIDR lookup that tells you which
  prefix would match.
- **DX Gateway route diff** — the headline capability. Compares every VIF on a gateway and flags
  prefixes with **no failover path**, using four states: exact match, covered by a less-specific
  route, partially covered, or genuinely absent. A gateway node shows a `⚠ N` gap count.
- Select any subset of VIFs and the comparison is *re-graded* for that subset, with the chosen VIFs
  lit up on the canvas.
- **Cross-gateway comparison** (via chat) — but only after checking whether the two gateways share a
  downstream, because two independent gateways are *supposed* to carry different prefixes.
- Route table viewers for Transit Gateway, VPC, and Cloud WAN segments, plus a VPC peering list;
  propagation state shown with an explicit "unknown" where permission is missing.
- Blackhole route detection across TGW and VPC route tables — a silently dropped prefix that
  generates no error anywhere in AWS.

## 7. Live status and telemetry

- One toggle paints operational state onto the diagram: green/amber/red edges, gateway and attachment
  state, per-tunnel VPN up/down, live BGP prefix counts per VIF.
- **Capacity utilisation** over 30/60/90 days, measured against each VIF's own rate limit rather than
  the port speed (a saturated 50 Mbps VIF on a 10 Gbps port used to read as 0.5%).
- **BGP session flap history** — counts genuine up→down transitions, so one long outage counts once.
- **Failover test history** — evidence redundancy was actually *exercised*, not just configured.
  Worded honestly as "no test found in available history", since only API-initiated tests are
  recorded.
- Five CloudWatch metrics total; only two are fetched automatically at login, the rest are behind
  explicit user-initiated toggles.

## 8. AWS Health / maintenance calendar

- A calendar of AWS Health events touching your DX resources, in two categories over two different
  windows: upcoming **planned maintenance** and past **AWS issues** (90-day lookback) — never
  presented as the same thing.
- Live badge with severity colour, next-activity jump, repeated reminders collapsed into one card per
  window.
- Affected-resource chips that spotlight the exact resource on the canvas; resource IDs inside AWS's
  prose are made clickable.
- Region-wide events for regions where you have no DX footprint are hidden, so a Frankfurt fault
  doesn't paint a red day on an estate that has never been in Frankfurt.
- Requires a Business+ support plan (an AWS Health API constraint, not ours).

## 9. AI chat assistant

- A streaming assistant that already knows your topology and current assessment — no copy-pasting
  context in.
- 11 tools it can call: live DX port pricing, TGW/VPN pricing, exact topology census, cross-gateway
  comparison, upgrade cost estimate, actual spend from Cost Explorer, daily DX cost trend, and four
  that drive the UI (switch view, toggle simulation, toggle live status, change scenario).
- Money questions always go to a live AWS pricing/cost API — never answered from model memory.
- Prompt-injection hardening on customer-supplied resource names, optional Bedrock Guardrail,
  conversation persistence, stop-generation, and a transcript that's wiped on sign-out, idle timeout,
  or tab close.
- Nothing that mutates AWS is on the tool surface.

## 10. Failure simulation and canvas editing

- Click to fail a link, device, or zone and watch the blast radius on the diagram, with a live count
  of what goes dark.
- Draw the customer-side cabling AWS can't see (router → colo device), re-route a cross-connect, add
  or remove data centres and routers — then lock the canvas so nothing moves by accident during a
  customer walkthrough.

## 11. Sharing, reporting and data protection

- **Sanitised JSON snapshot** — every account ID, resource ID, IP, CIDR, ASN, name, tag and colo code
  replaced with a stable pseudonym, consistently, so the topology still makes sense. The full-data
  export exists but is behind an explicit confirmation gate.
- A snapshot carries the real topology data (not a picture), plus the sender's exact view, hand-drawn
  edits and target tiers — the recipient re-grades it locally and can re-export it onward.
- An imported snapshot is pinned: refresh, sign-out and session timeout can't silently overwrite the
  customer's data.
- **Redact mode** for screenshares — display-only masking, one click.
- **Downloadable standalone HTML resilience report**: per-gateway posture and upgrade table, findings
  by severity, the Architecture/Configuration/Operations matrix, a per-DXGW BGP route-failover matrix,
  CloudWatch VIF utilization with N-1 failover headroom, and an inventory appendix. Print-ready.
- The report fetches its own BGP routes and CloudWatch metrics when they aren't already loaded, so it
  is never handed over with two empty sections; where a fetch is denied it prints what AWS said and
  which action would fix it, and never scores an unmeasured check as a pass.
- 4K PNG export of the diagram.
- A packaged Agent Skill (`nwra-skill`) that produces the same class of report without running
  the app at all.

## 12. Security, deployment and demo

- Credentials live in browser memory only, never on disk. IAM Identity Center (SSO) device flow with
  an account/role picker, or paste-in temporary credentials.
- Idle session timeout with a 60-second warning, then a full state wipe. Read-only least-privilege
  IAM policy shipped with the product.
- The SSO backend has a CORS allowlist that fails closed, CSRF gating and rate limiting; the OIDC
  client secret never reaches the browser.
- Ships as a static bundle you can host anywhere (S3 + CloudFront, nginx, or a no-install zip with
  start scripts).
- **Demo mode with five named scenarios** — No Resiliency, Development & Testing, High Resiliency,
  Maximum Resiliency, Cross-Account — switchable live, with baked-in route, flap, failover-test,
  utilisation and Health data. Zero AWS access needed.

---

## Authoritative counts

Read off the engine source, for anyone quoting numbers from this list:

| Thing | Count |
|---|---|
| Resiliency rules | 9 rule functions → **12** finding IDs |
| Best-practice rules | 26 rule functions → **30** finding IDs (four emit a separate healthy-path `-ok` ID) |
| Best-practice pillars | 3 — Architecture / Configuration / Operations |
| SLA tiers | 4 — No Resiliency, Dev & Test (95%), High (99.9%), Maximum (99.99%) |
| Numeric resiliency score | **none** — tiers plus met/unmet checklists, by design |
| Node types on the canvas | 23 registered renderers |
| Chat tools | 11 |
| CloudWatch metrics used | 5 (all `AWS/DX`) |
| Demo scenarios | 5 |
| AWS read operations in discovery | 40, across 10 services — no mutating call exists in the codebase |

## Known behaviour worth stating alongside the feature list

- Six best-practice checks — blackhole routes, VPC with no hybrid route, DXGW propagation, BGP flap
  history, VPN static-routes-only, VIF rate-limit oversubscription — have **no row in the on-screen
  Best Practices panel**. They reach the user through the downloadable HTML report and the chat
  context only.
- Three IAM actions the discovery needs are **not** covered by a `Describe*` wildcard and need explicit
  policy entries: `directconnect:ListVirtualInterfaceRoutes`,
  `directconnect:ListVirtualInterfaceTestHistory`, `ec2:GetTransitGatewayRouteTablePropagations`.
  Every rule backed by them degrades to guidance, or stays silent, rather than reporting a fault from
  missing data.

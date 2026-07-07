// Sanitizer: rewrite a TopologyData snapshot so the file leaving the user's
// machine contains zero real customer data while the graph still reconstructs.
//
// Same real value → same pseudo every time, so edges, route-table keys, and
// utilization Map keys still resolve. Pseudo values preserve the *shape* of
// the original (vpc-abc12345 → vpc-00000001, 10.1.2.3/24 → 203.0.113.0/24)
// so the SA's UI still reads as a coherent topology.
//
// Idempotent: re-running on already-sanitized output is a no-op (every pseudo
// the Sanitizer issues is registered as already-pseudo, so subsequent passes
// see them as fixed points).

import type { TopologyData } from '../types/topology';
import type {
  DxConnection,
  DxVirtualInterface,
  DxGateway,
  DxGatewayAssociation,
  DxLocation,
  DxLag,
  Vpc,
  VpnGateway,
  VpnConnection,
  VpnTunnel,
  TransitGateway,
  TransitGatewayAttachment,
  TransitGatewayPeeringAttachment,
  VpcPeeringConnection,
  CustomerGateway,
  CloudWanCoreNetwork,
  CloudWanAttachment,
  CloudWanPeering,
  CloudWanRoute,
  CloudWanSegmentRoutes,
  TgwRouteTableWithRoutes,
  TgwRoute,
  VpcRoute,
  VpcRouteTable,
  BgpPeer,
  DxMaintenanceEvent,
} from '../types/aws-resources';

// CIDRs/IPs that are routing sentinels rather than customer addresses — must
// not be rewritten or route-table semantics break ("default route to 0/0" is
// not the same as "default route to 203.0.113.0/24").
const SPECIAL_CIDRS = new Set(['0.0.0.0/0', '::/0']);
const SPECIAL_GATEWAY_IDS = new Set(['local']);

const RESOURCE_ID_RE =
  /\b(dx(?:con|vif|gw|lag)|vgw|vpc|tgw(?:-(?:attach|rtb|connect))?|vpn|cgw|subnet|eni|nat|igw|eigw|pcx|rtb|core-network|cnpx|attachment|global-network|pl)-[0-9a-f]+\b/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ACCOUNT_ID_RE = /\b\d{4}-?\d{4}-?\d{4}\b/g;
const CIDR_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/g;
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const ARN_RE = /arn:aws[\w-]*:[\w-]*:[\w-]*:(\d{12}):([\w/.-]+)/g;

function pad(n: number, width = 8): string {
  return String(n).padStart(width, '0');
}

export class Sanitizer {
  // Resource IDs by full original (e.g. "vpc-abc12345" → "vpc-00000001"),
  // shared across all resource kinds so a single id rewrites consistently
  // wherever it appears (including inside ARNs, free-text fields, route
  // targets, and Map keys).
  private resourceMap = new Map<string, string>();
  private prefixCounters = new Map<string, number>();
  // Pseudo values we have already issued — used to short-circuit
  // already-sanitized inputs (idempotency) and avoid double-mapping.
  private resourceAllocated = new Set<string>();

  private accountMap = new Map<string, string>();
  private accountAllocated = new Set<string>();
  private accountCounter = 0;

  private uuidMap = new Map<string, string>();
  private uuidAllocated = new Set<string>();
  private uuidCounter = 0;

  private ipMap = new Map<string, string>();
  private ipAllocated = new Set<string>();
  private ipCounter = 0;

  private cidrMap = new Map<string, string>();
  private cidrAllocated = new Set<string>();
  private cidrCounter = 0;

  private asnMap = new Map<number, number>();
  private asnAllocated = new Set<number>();
  private asnCounter = 64512;

  // Free-text — keyed by "kind:original" so the same name appearing as a
  // VIF and a tag value gets the same pseudo within a kind only.
  private nameMap = new Map<string, string>();
  private nameCounters = new Map<string, number>();

  private tagValueMap = new Map<string, string>();
  private tagValueCounter = 0;

  private locationMap = new Map<string, string>();
  private locationCounter = 0;

  private awsDeviceMap = new Map<string, string>();
  private awsDeviceCounter = 0;

  // ----- accessors / allocators -----

  resourceId(real: string | undefined): string {
    if (real == null) return real as unknown as string;
    if (this.resourceAllocated.has(real)) return real;
    if (SPECIAL_GATEWAY_IDS.has(real)) return real;
    const cached = this.resourceMap.get(real);
    if (cached) return cached;
    const dash = real.lastIndexOf('-');
    if (dash < 0) return real; // unrecognized shape — leave alone
    const prefix = real.slice(0, dash);
    const next = (this.prefixCounters.get(prefix) ?? 0) + 1;
    this.prefixCounters.set(prefix, next);
    const pseudo = `${prefix}-${pad(next)}`;
    this.resourceMap.set(real, pseudo);
    this.resourceAllocated.add(pseudo);
    return pseudo;
  }

  accountId(real: string | undefined): string {
    if (real == null) return real as unknown as string;
    const normalized = real.replace(/-/g, '');
    if (!/^\d{12}$/.test(normalized)) return real;
    if (this.accountAllocated.has(normalized)) return real.includes('-')
      ? `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8)}`
      : normalized;
    let pseudo = this.accountMap.get(normalized);
    if (!pseudo) {
      this.accountCounter += 1;
      // 9-prefix keeps pseudos visually distinct from real AWS account IDs.
      pseudo = `9${pad(this.accountCounter, 11)}`;
      this.accountMap.set(normalized, pseudo);
      this.accountAllocated.add(pseudo);
    }
    return real.includes('-')
      ? `${pseudo.slice(0, 4)}-${pseudo.slice(4, 8)}-${pseudo.slice(8)}`
      : pseudo;
  }

  uuid(real: string | undefined): string {
    if (real == null) return real as unknown as string;
    if (this.uuidAllocated.has(real)) return real;
    let pseudo = this.uuidMap.get(real);
    if (!pseudo) {
      this.uuidCounter += 1;
      // The trailing block deliberately contains hex letters so it can never
      // be mistaken for a 12-digit AWS account ID by a regex sweep.
      const hex = this.uuidCounter.toString(16).padStart(8, '0');
      pseudo = `${hex}-aaaa-4aaa-baaa-cafe${pad(this.uuidCounter, 8)}`;
      this.uuidMap.set(real, pseudo);
      this.uuidAllocated.add(pseudo);
    }
    return pseudo;
  }

  ip(real: string | undefined): string {
    if (real == null) return real as unknown as string;
    if (this.ipAllocated.has(real)) return real;
    let pseudo = this.ipMap.get(real);
    if (!pseudo) {
      this.ipCounter += 1;
      const c = this.ipCounter;
      // 203.0.113.0/24 (TEST-NET-3) gives 256 unique addresses; if exceeded
      // wrap into 198.51.100.0/24 (TEST-NET-2) for another 256.
      if (c <= 256) pseudo = `203.0.113.${c - 1}`;
      else if (c <= 512) pseudo = `198.51.100.${c - 257}`;
      else pseudo = `192.0.2.${(c - 513) % 256}`;
      this.ipMap.set(real, pseudo);
      this.ipAllocated.add(pseudo);
    }
    return pseudo;
  }

  cidr(real: string | undefined): string {
    if (real == null) return real as unknown as string;
    if (SPECIAL_CIDRS.has(real)) return real;
    if (this.cidrAllocated.has(real)) return real;
    let pseudo = this.cidrMap.get(real);
    if (!pseudo) {
      const slash = real.lastIndexOf('/');
      const mask = slash >= 0 ? real.slice(slash + 1) : '24';
      this.cidrCounter += 1;
      const idx = this.cidrCounter;
      // Allocate /24-aligned blocks inside TEST-NET-3, then TEST-NET-2,
      // then TEST-NET-1 — combined ~768 unique blocks before recycling.
      let base: string;
      if (idx <= 256) base = `203.0.113.${idx - 1}`;
      else if (idx <= 512) base = `198.51.100.${idx - 257}`;
      else base = `192.0.2.${(idx - 513) % 256}`;
      pseudo = `${base.replace(/\.\d+$/, '.0')}/${mask}`;
      this.cidrMap.set(real, pseudo);
      this.cidrAllocated.add(pseudo);
    }
    return pseudo;
  }

  asn(real: number | undefined): number | undefined {
    if (real == null) return real;
    if (this.asnAllocated.has(real)) return real;
    const cached = this.asnMap.get(real);
    if (cached != null) return cached;
    // Allocate sequentially in 64512–65534 (private 16-bit ASN range).
    let pseudo: number;
    do {
      this.asnCounter += 1;
      if (this.asnCounter > 65534) this.asnCounter = 64512;
      pseudo = this.asnCounter;
    } while (this.asnAllocated.has(pseudo));
    this.asnMap.set(real, pseudo);
    this.asnAllocated.add(pseudo);
    return pseudo;
  }

  asnString(real: string | undefined): string | undefined {
    if (real == null) return real;
    const n = Number(real);
    if (!Number.isFinite(n)) return real;
    return String(this.asn(n));
  }

  // Free-text name fields (Connection-1, VIF-1, Tgw-1, etc.). The kind tag
  // controls the prefix so the SA's view still reads as "this is a VIF" but
  // any internal naming (e.g. "corp-payroll-prod") is replaced.
  private namesAllocated = new Map<string, Set<string>>();
  name(kind: string, real: string | undefined): string | undefined {
    if (real == null || real === '') return real;
    const allocated = this.namesAllocated.get(kind);
    if (allocated?.has(real)) return real; // already a pseudo — idempotent
    const key = `${kind}::${real}`;
    const cached = this.nameMap.get(key);
    if (cached) return cached;
    const next = (this.nameCounters.get(kind) ?? 0) + 1;
    this.nameCounters.set(kind, next);
    const pseudo = `${kind}-${pad(next, 4)}`;
    this.nameMap.set(key, pseudo);
    if (!allocated) this.namesAllocated.set(kind, new Set([pseudo]));
    else allocated.add(pseudo);
    return pseudo;
  }

  description(real: string | undefined): string | undefined {
    if (real == null || real === '') return real;
    return this.name('Description', real);
  }

  // Tag values are user-controlled free-form strings (often emails, hostnames,
  // owner names). Replace en bloc — the key (e.g. "Name", "Owner") is kept so
  // structural meaning survives.
  private tagValueAllocated = new Set<string>();
  tagValue(real: string | undefined): string {
    if (real == null) return '';
    if (real === '') return '';
    if (this.tagValueAllocated.has(real)) return real;
    const cached = this.tagValueMap.get(real);
    if (cached) return cached;
    this.tagValueCounter += 1;
    const pseudo = `tag-value-${pad(this.tagValueCounter, 4)}`;
    this.tagValueMap.set(real, pseudo);
    this.tagValueAllocated.add(pseudo);
    return pseudo;
  }

  tags(real: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(real)) {
      out[k] = this.tagValue(v);
    }
    return out;
  }

  // Location codes (e.g. "EqDC2") leak the colocation facility identity. Pseudo
  // them so the SA can't infer which carrier hotel the customer is in.
  private locationAllocated = new Set<string>();
  locationCode(real: string | undefined): string {
    if (real == null || real === '') return real ?? '';
    if (this.locationAllocated.has(real)) return real;
    const cached = this.locationMap.get(real);
    if (cached) return cached;
    this.locationCounter += 1;
    const pseudo = `loc-${pad(this.locationCounter, 4)}`;
    this.locationMap.set(real, pseudo);
    this.locationAllocated.add(pseudo);
    return pseudo;
  }

  private awsDeviceAllocated = new Set<string>();
  awsDevice(real: string | undefined): string | undefined {
    if (real == null || real === '') return real;
    if (this.awsDeviceAllocated.has(real)) return real;
    const cached = this.awsDeviceMap.get(real);
    if (cached) return cached;
    this.awsDeviceCounter += 1;
    const pseudo = `aws-device-${pad(this.awsDeviceCounter, 4)}`;
    this.awsDeviceMap.set(real, pseudo);
    this.awsDeviceAllocated.add(pseudo);
    return pseudo;
  }

  // Generic regex pass for free-text fields (descriptions, error messages,
  // chat-shaped strings). Only used as a defensive last step on fields where
  // we don't know the structure.
  freeText(real: string | undefined): string | undefined {
    if (real == null) return real;
    let out = real;
    out = out.replace(UUID_RE, (m) => this.uuid(m));
    out = out.replace(RESOURCE_ID_RE, (m) => this.resourceId(m));
    out = out.replace(ACCOUNT_ID_RE, (m) => this.accountId(m));
    out = out.replace(CIDR_RE, (m) => this.cidr(m));
    out = out.replace(IP_RE, (m) => this.ip(m));
    return out;
  }

  // ARNs: replace just the account-id and resource segments. Keep the
  // service/region segments — they aren't sensitive.
  arn(real: string | undefined): string | undefined {
    if (real == null) return real;
    return real.replace(ARN_RE, (_match, account: string, resource: string) => {
      const pseudoAccount = this.accountId(account);
      const pseudoResource = resource
        .split('/')
        .map((seg) => {
          if (RESOURCE_ID_RE.test(seg)) {
            RESOURCE_ID_RE.lastIndex = 0;
            return this.resourceId(seg);
          }
          if (UUID_RE.test(seg)) {
            UUID_RE.lastIndex = 0;
            return this.uuid(seg);
          }
          return seg;
        })
        .join('/');
      return `arn:aws:${_match.split(':')[2]}:${_match.split(':')[3]}:${pseudoAccount}:${pseudoResource}`;
    });
  }

  // ----- structural sanitizers per AWS resource type -----

  private connection(c: DxConnection): DxConnection {
    return {
      ...c,
      connectionId: this.resourceId(c.connectionId),
      connectionName: this.name('Connection', c.connectionName) ?? c.connectionName,
      location: this.locationCode(c.location),
      lagId: c.lagId ? this.resourceId(c.lagId) : c.lagId,
      // partnerName is a public AWS partner string ("Equinix", "Megaport") —
      // keep verbatim.
      awsDeviceV2: this.awsDevice(c.awsDeviceV2),
      awsLogicalDeviceId: this.awsDevice(c.awsLogicalDeviceId),
    };
  }

  private bgpPeer(p: BgpPeer): BgpPeer {
    return {
      ...p,
      bgpPeerId: this.resourceId(p.bgpPeerId),
      asn: this.asn(p.asn) ?? p.asn,
      customerAddress: this.cidr(p.customerAddress),
      amazonAddress: this.cidr(p.amazonAddress),
    };
  }

  private vif(v: DxVirtualInterface): DxVirtualInterface {
    return {
      ...v,
      virtualInterfaceId: this.resourceId(v.virtualInterfaceId),
      virtualInterfaceName: this.name('VIF', v.virtualInterfaceName) ?? v.virtualInterfaceName,
      connectionId: this.resourceId(v.connectionId),
      directConnectGatewayId: v.directConnectGatewayId ? this.uuid(v.directConnectGatewayId) : v.directConnectGatewayId,
      virtualGatewayId: v.virtualGatewayId ? this.resourceId(v.virtualGatewayId) : v.virtualGatewayId,
      asn: this.asn(v.asn) ?? v.asn,
      bgpPeers: v.bgpPeers.map((p) => this.bgpPeer(p)),
      location: v.location ? this.locationCode(v.location) : v.location,
      ownerAccount: v.ownerAccount ? this.accountId(v.ownerAccount) : v.ownerAccount,
      awsDeviceV2: this.awsDevice(v.awsDeviceV2),
      awsLogicalDeviceId: this.awsDevice(v.awsLogicalDeviceId),
    };
  }

  private dxGateway(g: DxGateway): DxGateway {
    return {
      ...g,
      directConnectGatewayId: this.uuid(g.directConnectGatewayId),
      directConnectGatewayName: this.name('DXGW', g.directConnectGatewayName) ?? g.directConnectGatewayName,
      amazonSideAsn: this.asn(g.amazonSideAsn) ?? g.amazonSideAsn,
    };
  }

  private dxgwAssoc(a: DxGatewayAssociation): DxGatewayAssociation {
    return {
      ...a,
      directConnectGatewayId: this.uuid(a.directConnectGatewayId),
      associationId: a.associationId ? this.uuid(a.associationId) : a.associationId,
      associatedGateway: {
        ...a.associatedGateway,
        id: a.associatedGateway.id ? this.resourceId(a.associatedGateway.id) : a.associatedGateway.id,
        ownerAccount: this.accountId(a.associatedGateway.ownerAccount),
      },
      associatedCoreNetwork: a.associatedCoreNetwork
        ? {
            id: this.resourceId(a.associatedCoreNetwork.id),
            ownerAccount: this.accountId(a.associatedCoreNetwork.ownerAccount),
            attachmentId: this.resourceId(a.associatedCoreNetwork.attachmentId),
          }
        : a.associatedCoreNetwork,
      allowedPrefixes: a.allowedPrefixes.map((c) => this.cidr(c)),
    };
  }

  private location(l: DxLocation): DxLocation {
    return {
      ...l,
      locationCode: this.locationCode(l.locationCode),
      locationName: this.name('Location', l.locationName) ?? l.locationName,
    };
  }

  private lag(l: DxLag): DxLag {
    return {
      ...l,
      lagId: this.resourceId(l.lagId),
      lagName: this.name('LAG', l.lagName) ?? l.lagName,
      location: this.locationCode(l.location),
      connections: l.connections.map((c) => this.connection(c)),
    };
  }

  private vpc(v: Vpc): Vpc {
    return {
      ...v,
      vpcId: this.resourceId(v.vpcId),
      cidrBlock: this.cidr(v.cidrBlock),
      tags: this.tags(v.tags),
      ownerAccountId: v.ownerAccountId ? this.accountId(v.ownerAccountId) : v.ownerAccountId,
    };
  }

  private vgw(g: VpnGateway): VpnGateway {
    return {
      ...g,
      vpnGatewayId: this.resourceId(g.vpnGatewayId),
      vpcAttachments: g.vpcAttachments.map((a) => ({ ...a, vpcId: this.resourceId(a.vpcId) })),
      amazonSideAsn: this.asn(g.amazonSideAsn) ?? g.amazonSideAsn,
      tags: this.tags(g.tags),
    };
  }

  private tgw(t: TransitGateway): TransitGateway {
    return {
      ...t,
      transitGatewayId: this.resourceId(t.transitGatewayId),
      transitGatewayArn: this.arn(t.transitGatewayArn) ?? t.transitGatewayArn,
      ownerId: this.accountId(t.ownerId),
      description: this.description(t.description) ?? t.description,
      amazonSideAsn: this.asn(t.amazonSideAsn) ?? t.amazonSideAsn,
      tags: this.tags(t.tags),
    };
  }

  private tgwAttachment(a: TransitGatewayAttachment): TransitGatewayAttachment {
    return {
      ...a,
      transitGatewayAttachmentId: this.resourceId(a.transitGatewayAttachmentId),
      transitGatewayId: this.resourceId(a.transitGatewayId),
      resourceId: a.resourceType === 'direct-connect-gateway'
        ? this.uuid(a.resourceId)
        : this.resourceId(a.resourceId),
      resourceOwnerId: this.accountId(a.resourceOwnerId),
      name: a.name ? this.name('TGWAttach', a.name) : a.name,
    };
  }

  private vpcPeering(p: VpcPeeringConnection): VpcPeeringConnection {
    return {
      ...p,
      vpcPeeringConnectionId: this.resourceId(p.vpcPeeringConnectionId),
      requesterVpc: {
        ...p.requesterVpc,
        vpcId: this.resourceId(p.requesterVpc.vpcId),
        cidrBlock: this.cidr(p.requesterVpc.cidrBlock),
        ownerId: this.accountId(p.requesterVpc.ownerId),
      },
      accepterVpc: {
        ...p.accepterVpc,
        vpcId: this.resourceId(p.accepterVpc.vpcId),
        cidrBlock: this.cidr(p.accepterVpc.cidrBlock),
        ownerId: this.accountId(p.accepterVpc.ownerId),
      },
      tags: this.tags(p.tags),
    };
  }

  private tgwPeering(p: TransitGatewayPeeringAttachment): TransitGatewayPeeringAttachment {
    return {
      ...p,
      transitGatewayAttachmentId: this.resourceId(p.transitGatewayAttachmentId),
      requesterTgwInfo: {
        ...p.requesterTgwInfo,
        transitGatewayId: this.resourceId(p.requesterTgwInfo.transitGatewayId),
        ownerId: this.accountId(p.requesterTgwInfo.ownerId),
      },
      accepterTgwInfo: {
        ...p.accepterTgwInfo,
        transitGatewayId: this.resourceId(p.accepterTgwInfo.transitGatewayId),
        ownerId: this.accountId(p.accepterTgwInfo.ownerId),
      },
      tags: this.tags(p.tags),
    };
  }

  private vpnTunnel(t: VpnTunnel): VpnTunnel {
    return {
      ...t,
      outsideIpAddress: this.ip(t.outsideIpAddress),
      // statusMessage is a free-form AWS string ("Tunnel is up", "BGP not
      // established") — pass through.
    };
  }

  private vpn(v: VpnConnection): VpnConnection {
    return {
      ...v,
      vpnConnectionId: this.resourceId(v.vpnConnectionId),
      vpnGatewayId: v.vpnGatewayId ? this.resourceId(v.vpnGatewayId) : v.vpnGatewayId,
      transitGatewayId: v.transitGatewayId ? this.resourceId(v.transitGatewayId) : v.transitGatewayId,
      customerGatewayId: this.resourceId(v.customerGatewayId),
      customerGatewayAddress: this.ip(v.customerGatewayAddress),
      tunnels: v.tunnels.map((t) => this.vpnTunnel(t)),
      tags: this.tags(v.tags),
    };
  }

  private cgw(c: CustomerGateway): CustomerGateway {
    return {
      ...c,
      customerGatewayId: this.resourceId(c.customerGatewayId),
      bgpAsn: this.asnString(c.bgpAsn) ?? c.bgpAsn,
      ipAddress: this.ip(c.ipAddress),
      tags: this.tags(c.tags),
    };
  }

  private cwCoreNetwork(n: CloudWanCoreNetwork): CloudWanCoreNetwork {
    return {
      ...n,
      coreNetworkId: this.resourceId(n.coreNetworkId),
      coreNetworkArn: this.arn(n.coreNetworkArn) ?? n.coreNetworkArn,
      globalNetworkId: this.resourceId(n.globalNetworkId),
      description: this.description(n.description) ?? n.description,
      edges: n.edges.map((e) => ({
        ...e,
        // edgeLocation is the AWS region code ("us-east-1") — public.
        asn: this.asn(e.asn) ?? e.asn,
        insideCidrBlocks: e.insideCidrBlocks.map((c) => this.cidr(c)),
      })),
      segments: n.segments.map((s) => ({
        ...s,
        name: this.name('Segment', s.name) ?? s.name,
        sharedSegments: s.sharedSegments.map((x) => this.name('Segment', x) ?? x),
      })),
    };
  }

  private cwAttachment(a: CloudWanAttachment): CloudWanAttachment {
    return {
      ...a,
      attachmentId: this.resourceId(a.attachmentId),
      coreNetworkId: this.resourceId(a.coreNetworkId),
      ownerAccountId: this.accountId(a.ownerAccountId),
      resourceArn: this.arn(a.resourceArn) ?? a.resourceArn,
      segmentName: this.name('Segment', a.segmentName) ?? a.segmentName,
      tags: this.tags(a.tags),
    };
  }

  private cwPeering(p: CloudWanPeering): CloudWanPeering {
    return {
      ...p,
      // peeringId format isn't a known prefixed shape across AWS — try the
      // resource path; if it doesn't have a "-" the helper passes it through.
      peeringId: this.resourceId(p.peeringId),
      coreNetworkId: this.resourceId(p.coreNetworkId),
      resourceArn: this.arn(p.resourceArn) ?? p.resourceArn,
      tags: this.tags(p.tags),
    };
  }

  private cwRoute(r: CloudWanRoute): CloudWanRoute {
    return {
      ...r,
      destinationCidrBlock: this.cidr(r.destinationCidrBlock),
      destinations: r.destinations.map((d) => ({
        ...d,
        coreNetworkAttachmentId: this.resourceId(d.coreNetworkAttachmentId),
        segmentName: this.name('Segment', d.segmentName) ?? d.segmentName,
        resourceId: this.resourceId(d.resourceId),
      })),
    };
  }

  private cwSegmentRoutes(s: CloudWanSegmentRoutes): CloudWanSegmentRoutes {
    return {
      ...s,
      segmentName: this.name('Segment', s.segmentName) ?? s.segmentName,
      routes: s.routes.map((r) => this.cwRoute(r)),
    };
  }

  private vpcRoute(r: VpcRoute): VpcRoute {
    const out: VpcRoute = { ...r };
    if (r.destinationCidrBlock) out.destinationCidrBlock = this.cidr(r.destinationCidrBlock);
    if (r.destinationPrefixListId) out.destinationPrefixListId = this.resourceId(r.destinationPrefixListId);
    if (r.gatewayId && !SPECIAL_GATEWAY_IDS.has(r.gatewayId)) out.gatewayId = this.resourceId(r.gatewayId);
    if (r.natGatewayId) out.natGatewayId = this.resourceId(r.natGatewayId);
    if (r.transitGatewayId) out.transitGatewayId = this.resourceId(r.transitGatewayId);
    if (r.vpcPeeringConnectionId) out.vpcPeeringConnectionId = this.resourceId(r.vpcPeeringConnectionId);
    if (r.networkInterfaceId) out.networkInterfaceId = this.resourceId(r.networkInterfaceId);
    if (r.egressOnlyInternetGatewayId) out.egressOnlyInternetGatewayId = this.resourceId(r.egressOnlyInternetGatewayId);
    if (r.carrierGatewayId) out.carrierGatewayId = this.resourceId(r.carrierGatewayId);
    if (r.localGatewayId) out.localGatewayId = this.resourceId(r.localGatewayId);
    if (r.coreNetworkArn) out.coreNetworkArn = this.arn(r.coreNetworkArn) ?? r.coreNetworkArn;
    if (r.instanceId) out.instanceId = this.resourceId(r.instanceId);
    return out;
  }

  private vpcRouteTable(rt: VpcRouteTable): VpcRouteTable {
    return {
      ...rt,
      routeTableId: this.resourceId(rt.routeTableId),
      vpcId: this.resourceId(rt.vpcId),
      associatedSubnetIds: rt.associatedSubnetIds.map((s) => this.resourceId(s)),
      tags: this.tags(rt.tags),
      routes: rt.routes.map((r) => this.vpcRoute(r)),
    };
  }

  private tgwRoute(r: TgwRoute): TgwRoute {
    return {
      ...r,
      destinationCidrBlock: this.cidr(r.destinationCidrBlock),
      transitGatewayAttachments: r.transitGatewayAttachments.map((a) => ({
        ...a,
        transitGatewayAttachmentId: this.resourceId(a.transitGatewayAttachmentId),
        resourceId: this.resourceId(a.resourceId),
      })),
    };
  }

  private tgwRouteTableWithRoutes(rt: TgwRouteTableWithRoutes): TgwRouteTableWithRoutes {
    return {
      routeTable: {
        ...rt.routeTable,
        transitGatewayRouteTableId: this.resourceId(rt.routeTable.transitGatewayRouteTableId),
        transitGatewayId: this.resourceId(rt.routeTable.transitGatewayId),
        tags: this.tags(rt.routeTable.tags),
      },
      routes: rt.routes.map((r) => this.tgwRoute(r)),
    };
  }

  private maintenanceEvent(e: DxMaintenanceEvent): DxMaintenanceEvent {
    return {
      ...e,
      arn: this.arn(e.arn) ?? e.arn,
      affectedResourceIds: e.affectedResourceIds.map((id) =>
        UUID_RE.test(id) ? (UUID_RE.lastIndex = 0, this.uuid(id)) : this.resourceId(id),
      ),
      description: this.freeText(e.description) ?? e.description,
      accountId: e.accountId ? this.accountId(e.accountId) : e.accountId,
    };
  }

  // ----- top-level entry point -----

  sanitizeTopology(td: TopologyData): TopologyData {
    const tgwRouteTables = new Map<string, TgwRouteTableWithRoutes[]>();
    for (const [k, v] of td.tgwRouteTables.entries()) {
      tgwRouteTables.set(this.resourceId(k), v.map((rt) => this.tgwRouteTableWithRoutes(rt)));
    }
    const vpcRouteTables = new Map<string, VpcRouteTable[]>();
    for (const [k, v] of td.vpcRouteTables.entries()) {
      vpcRouteTables.set(this.resourceId(k), v.map((rt) => this.vpcRouteTable(rt)));
    }
    const cloudWanRoutes = new Map<string, CloudWanSegmentRoutes[]>();
    for (const [k, v] of td.cloudWanRoutes.entries()) {
      cloudWanRoutes.set(this.resourceId(k), v.map((r) => this.cwSegmentRoutes(r)));
    }

    const bgpPrefixMetrics = td.bgpPrefixMetrics
      ? new Map([...td.bgpPrefixMetrics.entries()].map(([k, v]) => [this.resourceId(k), v]))
      : undefined;
    const vifUtilization = td.vifUtilization
      ? new Map([...td.vifUtilization.entries()].map(([k, v]) => [this.resourceId(k), v]))
      : undefined;
    const connectionUtilization = td.connectionUtilization
      ? new Map([...td.connectionUtilization.entries()].map(([k, v]) => [this.resourceId(k), v]))
      : undefined;
    // Region codes ("us-east-1") are public AWS strings — pass keys and values
    // through verbatim.
    const regionNames = td.regionNames ? new Map(td.regionNames) : undefined;

    return {
      connections: td.connections.map((c) => this.connection(c)),
      virtualInterfaces: td.virtualInterfaces.map((v) => this.vif(v)),
      dxGateways: td.dxGateways.map((g) => this.dxGateway(g)),
      dxGatewayAssociations: td.dxGatewayAssociations.map((a) => this.dxgwAssoc(a)),
      locations: td.locations.map((l) => this.location(l)),
      lags: td.lags.map((l) => this.lag(l)),
      vpcs: td.vpcs.map((v) => this.vpc(v)),
      vpnGateways: td.vpnGateways.map((v) => this.vgw(v)),
      vpnConnections: td.vpnConnections.map((v) => this.vpn(v)),
      transitGateways: td.transitGateways.map((t) => this.tgw(t)),
      transitGatewayAttachments: td.transitGatewayAttachments.map((a) => this.tgwAttachment(a)),
      transitGatewayPeeringAttachments: td.transitGatewayPeeringAttachments.map((p) => this.tgwPeering(p)),
      vpcPeerings: td.vpcPeerings.map((p) => this.vpcPeering(p)),
      customerGateways: td.customerGateways.map((c) => this.cgw(c)),
      cloudWanCoreNetworks: td.cloudWanCoreNetworks.map((n) => this.cwCoreNetwork(n)),
      cloudWanAttachments: td.cloudWanAttachments.map((a) => this.cwAttachment(a)),
      cloudWanPeerings: td.cloudWanPeerings.map((p) => this.cwPeering(p)),
      tgwRouteTables,
      vpcRouteTables,
      cloudWanRoutes,
      bgpPrefixMetrics,
      vifUtilization,
      connectionUtilization,
      utilizationWindowDays: td.utilizationWindowDays,
      maintenanceEvents: td.maintenanceEvents?.map((e) => this.maintenanceEvent(e)),
      homeAccountId: td.homeAccountId ? this.accountId(td.homeAccountId) : td.homeAccountId,
      regionNames,
    };
  }

  // Rewrite a single utilization-window cache entry's keys so the SA's view
  // can flip between 30/60/90 windows without losing the VIF/connection
  // joins. Resource IDs already seen by sanitizeTopology resolve to the
  // same pseudo here (the resourceMap is shared on this Sanitizer).
  utilizationWindow(
    entry: { vif: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>; connection: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }> },
  ): { vif: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>; connection: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }> } {
    return {
      vif: new Map([...entry.vif.entries()].map(([k, v]) => [this.resourceId(k), v])),
      connection: new Map([...entry.connection.entries()].map(([k, v]) => [this.resourceId(k), v])),
    };
  }
}

export function sanitizeTopology(td: TopologyData): TopologyData {
  return new Sanitizer().sanitizeTopology(td);
}

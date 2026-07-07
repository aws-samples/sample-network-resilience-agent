import type { TopologyData } from '../types/topology';
import type { DxConnection, DxLag } from '../types/aws-resources';

/**
 * Member-connection count of a real LAG — the number a ghost mirroring this LAG
 * should draw. Prefers the authoritative `numberOfConnections` (what
 * `topology-builder` renders on the real LAG bundle edge), falls back to the
 * echoed member array, then to 2 (the historical ghost default) when a fixture
 * reports neither.
 */
export function lagMemberCount(lag: DxLag): number {
  return lag.numberOfConnections || lag.connections.length || 2;
}

/**
 * Collect distinct DX location codes used in the topology.
 * Prefers connection locations; falls back to VIF locations for hosted-VIF accounts.
 */
export function getUsedLocations(topology: TopologyData): Set<string> {
  const locations = new Set<string>();
  for (const conn of topology.connections) {
    if (conn.location) locations.add(conn.location);
  }
  if (locations.size === 0) {
    for (const vif of topology.virtualInterfaces) {
      if (vif.location) locations.add(vif.location);
    }
  }
  return locations;
}

/**
 * Count *distinct AWS logical devices* per DX location.
 *
 * Max tier (99.99%) requires 2+ different AWS routers at each location — two
 * connections sharing one `awsLogicalDeviceId` terminate on the same physical
 * device and don't survive a device failure. When the logical ID is missing
 * (sometimes true for hosted VIFs), fall back to the connection / VIF ID so
 * each raw entry still counts once — we err toward the more generous read
 * when AWS doesn't expose device identity.
 *
 * This is the single source of truth for "how many redundant devices does
 * location X have". Every place that gates on the Max SLA (tier
 * determination, ghost-node rules, scorecard UI, HTML report, cost estimator)
 * should call this helper rather than counting raw `topology.connections`.
 */
export function getLocationDeviceCounts(topology: TopologyData): Map<string, number> {
  const locationDevices = new Map<string, Set<string>>();

  const addDevice = (loc: string, deviceKey: string) => {
    if (!loc) return;
    let set = locationDevices.get(loc);
    if (!set) {
      set = new Set();
      locationDevices.set(loc, set);
    }
    set.add(deviceKey);
  };

  if (topology.connections.length > 0) {
    for (const conn of topology.connections) {
      const vif = topology.virtualInterfaces.find((v) => v.connectionId === conn.connectionId);
      const deviceKey = conn.awsLogicalDeviceId || vif?.awsLogicalDeviceId || conn.connectionId;
      addDevice(conn.location, deviceKey);
    }
  } else {
    // Fallback: no owned connections — infer from VIFs (hosted-VIF accounts).
    for (const vif of topology.virtualInterfaces) {
      const deviceKey = vif.awsLogicalDeviceId || vif.connectionId || vif.virtualInterfaceId;
      addDevice(vif.location ?? '', deviceKey);
    }
  }

  const counts = new Map<string, number>();
  for (const [loc, set] of locationDevices) counts.set(loc, set.size);
  return counts;
}

/**
 * Per-location summary of the AWS logical devices that carry a *sink-connected*
 * path — i.e. at least one VIF terminating on a DX Gateway (private/transit VIF
 * with `directConnectGatewayId`), on a Virtual Private Gateway reached over
 * Direct Connect (private VIF with `virtualGatewayId`), OR on the public
 * endpoint (a `public` VIF).
 *
 * `deviceCount` counts DISTINCT such logical devices; `hasLag` is true when any
 * of those sink-connected devices belongs to a LAG. A DX-reached VGW has the
 * same site/device redundancy posture as a DXGW, so its feeding devices count
 * as sink devices. (A VPN-only VGW has no DX-side VIF at all, so it never shows
 * up here — its resiliency story is tunnel/CGW redundancy, handled elsewhere.)
 */
export interface SinkDeviceInfo {
  deviceCount: number;
  hasLag: boolean;
  // When `hasLag`, the member-connection count of the sink-connected LAG at this
  // location — the number a ghost LAG mirroring this location should draw. When
  // several LAGs sink here, this is the LARGEST (a capacity-faithful mirror);
  // 0 when the location runs no sink-connected LAG.
  lagMemberCount: number;
}

export function getSinkConnectedDevices(
  topology: TopologyData,
  // Source of LAG identity for the device-identity match. Defaults to
  // `topology`, but callers pass the FULL topology while `topology` is a
  // per-sink SCOPE (per-DXGW / public-only) so the LAG-vs-plain shape follows
  // THAT sink's own existing path — a location whose LAG serves a *different*
  // sink must not force a LAG ghost onto this one. The scope may have stripped
  // the LAG's member connections (they carry no VIF for this sink), so
  // LAG-bundle-device identity is resolved against `lagSource` to still flag a
  // scoped device that coincides with a LAG bundle device (MGMT-on-LAG-device).
  lagSource: TopologyData = topology,
  // When true, a private VIF terminating on a Virtual Private Gateway
  // (`virtualGatewayId`) also counts as a sink. Off by default so the DXGW /
  // LAG / public reuse logic keeps its historical semantics (a VGW-only device
  // is not a redundant path for those sinks); the per-VGW scope opts in so its
  // own ghost shape (LAG vs plain) follows the VGW's real DX path.
  includeVgw = false,
): Map<string, SinkDeviceInfo> {
  const connById = new Map<string, DxConnection>();
  for (const conn of topology.connections) connById.set(conn.connectionId, conn);
  const lagConnById = new Map<string, DxConnection>();
  for (const conn of lagSource.connections) lagConnById.set(conn.connectionId, conn);

  // Connection IDs of LAG member connections — used to flag LAG-backed devices.
  // `lagCountByConn` maps each such member connection to its LAG's member count
  // so a ghost mirroring the device draws the right number of connections.
  const lagConnIds = new Set<string>();
  const lagCountByConn = new Map<string, number>();
  for (const lag of lagSource.lags) {
    const count = lagMemberCount(lag);
    for (const c of lag.connections) {
      if (c.connectionId) {
        lagConnIds.add(c.connectionId);
        lagCountByConn.set(c.connectionId, count);
      }
    }
  }
  // A connection is also LAG-backed when it carries a lagId directly (member
  // connections aren't always echoed under lag.connections in every snapshot).
  const lagIdByConn = new Map<string, string | undefined>();
  for (const conn of topology.connections) lagIdByConn.set(conn.connectionId, conn.lagId);
  // Member count keyed by lagId, for the direct-lagId flag path above.
  const lagCountById = new Map<string, number>();
  for (const lag of lagSource.lags) lagCountById.set(lag.lagId, lagMemberCount(lag));

  // Logical devices a LAG BUNDLE terminates on, keyed by "loc\x00device". A
  // location "runs a LAG that sinks to the DXGW/public endpoint" whenever a
  // sink-connected device is one of these bundle devices — EVEN IF the specific
  // sink VIF rides a non-member connection that happens to land on that same
  // device (real-data shape: a plain MGMT connection sharing the LAG's device).
  const lagBundleDevices = new Map<string, number>();
  const markLagDevice = (loc: string | undefined, device: string | undefined, count: number) => {
    if (!loc || !device) return;
    const key = `${loc}\x00${device}`;
    lagBundleDevices.set(key, Math.max(lagBundleDevices.get(key) ?? 0, count));
  };
  for (const lag of lagSource.lags) {
    const count = lagMemberCount(lag);
    for (const member of lag.connections) {
      const conn = lagConnById.get(member.connectionId) ?? member;
      markLagDevice(conn.location ?? lag.location, conn.awsLogicalDeviceId, count);
    }
    // Also fold in any connection carrying this lagId directly (members not
    // always echoed under lag.connections).
    for (const conn of lagSource.connections) {
      if (conn.lagId === lag.lagId) markLagDevice(conn.location, conn.awsLogicalDeviceId, count);
    }
  }

  // devices[loc] → Set of logical device keys; lagAtLoc[loc] → any device is LAG;
  // lagCountAtLoc[loc] → largest sink-connected LAG member count seen at loc.
  const devices = new Map<string, Set<string>>();
  const lagAtLoc = new Map<string, boolean>();
  const lagCountAtLoc = new Map<string, number>();

  const add = (loc: string | undefined, deviceKey: string, isLag: boolean, lagCount: number) => {
    if (!loc) return;
    let set = devices.get(loc);
    if (!set) {
      set = new Set();
      devices.set(loc, set);
    }
    set.add(deviceKey);
    if (isLag) {
      lagAtLoc.set(loc, true);
      lagCountAtLoc.set(loc, Math.max(lagCountAtLoc.get(loc) ?? 0, lagCount));
    } else if (!lagAtLoc.has(loc)) lagAtLoc.set(loc, false);
  };

  for (const vif of topology.virtualInterfaces) {
    const isSink = Boolean(vif.directConnectGatewayId)
      || (includeVgw && Boolean(vif.virtualGatewayId))
      || vif.virtualInterfaceType === 'public';
    if (!isSink) continue;

    const conn = connById.get(vif.connectionId);
    const loc = conn?.location ?? vif.location;
    const deviceKey = conn?.awsLogicalDeviceId || vif.awsLogicalDeviceId || vif.connectionId;
    // LAG-backed when the VIF's own connection is a LAG member, OR the sink
    // device is a device the LAG bundle terminates on (device-identity match).
    const directLagId = lagIdByConn.get(vif.connectionId);
    const bundleKey = loc != null ? `${loc}\x00${deviceKey}` : '';
    const isLag = lagConnIds.has(vif.connectionId)
      || Boolean(directLagId)
      || (loc != null && lagBundleDevices.has(bundleKey));
    // Mirror count: the LAG this specific sink path rides, falling back to the
    // largest LAG bundle on the same device.
    const lagCount = isLag
      ? (lagCountByConn.get(vif.connectionId)
        ?? (directLagId ? lagCountById.get(directLagId) : undefined)
        ?? lagBundleDevices.get(bundleKey)
        ?? 2)
      : 0;
    add(loc, deviceKey, isLag, lagCount);
  }

  const out = new Map<string, SinkDeviceInfo>();
  for (const [loc, set] of devices) {
    out.set(loc, {
      deviceCount: set.size,
      hasLag: lagAtLoc.get(loc) ?? false,
      lagMemberCount: lagCountAtLoc.get(loc) ?? 0,
    });
  }
  return out;
}

/**
 * Find an existing DX location to REUSE for a redundant ghost path, subject to
 * the revised resiliency rules:
 *
 *   Rule 1 — the reuse location must ALREADY have a sink-connected path (a real
 *            device carrying a VIF to a DXGW/public endpoint). We never invent
 *            redundant DX topology at a site that has none.
 *   Rule 2 — a location with 2 sink-connected devices is already fully
 *            device-redundant → not a reuse target (skip to the next).
 *
 * `excludeLocations` are the scope's own location codes (the reuse site must be
 * a genuinely different, redundant one). `sinkDevices` is the map from
 * `getSinkConnectedDevices`. Returns a location code (deterministic, topology
 * order) or `undefined` when no other qualifying location exists.
 */
export function findReusableSinkLocation(
  topology: TopologyData,
  excludeLocations: Iterable<string>,
  sinkDevices: Map<string, SinkDeviceInfo>,
): string | undefined {
  const excluded = new Set(excludeLocations);
  const ordered = topology.locations.length > 0
    ? topology.locations.map((l) => l.locationCode)
    : [...sinkDevices.keys()];

  const candidates = ordered.filter((code) => {
    if (excluded.has(code)) return false;
    const info = sinkDevices.get(code);
    // Rule 1: must already have a sink-connected path. Rule 2: skip if already
    // device-redundant (2+ sink devices).
    return !!info && info.deviceCount >= 1 && info.deviceCount < MAX_DEVICES_PER_LOCATION;
  });

  return candidates[0];
}

/**
 * Maximum resiliency (99.99%) needs 2 AWS logical devices per DX location. We
 * count a MAXIMUM of 2 devices per location for tier determination; a location
 * that already has 2+ devices is fully device-redundant. (Locations can have
 * more than 2 pre-existing devices — that's fine and is never a reason to
 * recommend removing any.)
 */
export const MAX_DEVICES_PER_LOCATION = 2;

/**
 * Find an existing DX location that a second-location recommendation can REUSE
 * instead of minting a brand-new ghost site. Most topologies already have DX
 * locations with AWS logical devices to link a redundant path into, so reuse is
 * ALWAYS preferred over inventing a new location — a location with plenty of
 * devices is in fact the ideal reuse target (it's already device-redundant).
 *
 * `excludeLocations` are the codes the recommendation's own scope already uses
 * (the reused site must be a *different*, genuinely redundant one). `deviceCounts`
 * reflects BOTH real devices AND ghost devices already assigned earlier in the
 * pass; it is used only as a tie-breaker preference — a location with spare
 * capacity (< 2 devices) is picked before a fuller one so ghost devices spread
 * across sites rather than piling onto one. A "full" location is still eligible.
 *
 * Returns a location code (deterministic, topology order) or `undefined` only
 * when there is NO other existing location to reuse (caller then mints a ghost).
 */
export function findReusableLocation(
  topology: TopologyData,
  excludeLocations: Iterable<string>,
  deviceCounts: Map<string, number>,
): string | undefined {
  const excluded = new Set(excludeLocations);

  // Candidate existing locations (with devices) that aren't the scope's own,
  // in deterministic topology order. Fall back to device-count keys for
  // hosted-VIF topologies that have no `locations` entries.
  const ordered = topology.locations.length > 0
    ? topology.locations.map((l) => l.locationCode)
    : [...deviceCounts.keys()];
  const candidates = ordered.filter(
    (code) => !excluded.has(code) && (deviceCounts.get(code) ?? 0) > 0,
  );
  if (candidates.length === 0) return undefined;

  // Prefer a location with spare device capacity (< 2) so ghost devices spread
  // across sites; otherwise reuse the first existing location regardless.
  const withCapacity = candidates.find(
    (code) => (deviceCounts.get(code) ?? 0) < MAX_DEVICES_PER_LOCATION,
  );
  return withCapacity ?? candidates[0];
}

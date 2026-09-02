import type { AwsCredentials, DxVirtualInterface, VifRoutes } from '../types/aws-resources';
import { createDxClient } from './aws-client';
import { fetchVirtualInterfaceRoutes } from './direct-connect';

/**
 * Fetch actual BGP routes (accepted + advertised) for every VIF, via
 * ListVirtualInterfaceRoutes — AWS Direct Connect BGP route visibility.
 *
 * This is deliberately NOT part of the login fetch in fetch-topology.ts. It's
 * two paginated calls per VIF, and the signal — the exact prefixes on the wire
 * — only matters when someone is actively troubleshooting routing. The
 * "BGP Routes" overlay calls this on demand, same as utilization.
 *
 * Routes are a regional DX API, so VIFs are grouped by their own region and
 * each group gets a client for that region. Per-VIF failures (AccessDenied on a
 * single cross-account VIF, a session that just went down) degrade to an
 * omitted map entry rather than failing the whole batch — callers treat a
 * missing entry as "no data" and fall back to CloudWatch prefix counts.
 */
export async function fetchVifRoutes(
  creds: AwsCredentials,
  vifs: DxVirtualInterface[],
): Promise<Map<string, VifRoutes>> {
  const result = new Map<string, VifRoutes>();

  // Only available VIFs have a live BGP session; anything else has no routes to
  // return and would just burn a call per VIF.
  const eligible = vifs.filter((v) => /available/i.test(v.virtualInterfaceState));
  if (eligible.length === 0) return result;

  const byRegion = new Map<string, DxVirtualInterface[]>();
  for (const vif of eligible) {
    const region = vif.region || creds.region;
    const list = byRegion.get(region) ?? [];
    list.push(vif);
    byRegion.set(region, list);
  }

  await Promise.all([...byRegion.entries()].map(async ([region, regionVifs]) => {
    const client = createDxClient({ ...creds, region });
    let failed = 0;
    await Promise.all(regionVifs.map(async (vif) => {
      try {
        const routes = await fetchVirtualInterfaceRoutes(client, vif.virtualInterfaceId);
        // Skip VIFs that returned nothing in either direction so downstream
        // `has()` checks mean "we actually have routes", not "we tried".
        if (routes.accepted.length > 0 || routes.advertised.length > 0) {
          result.set(vif.virtualInterfaceId, routes);
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[AWS] ${region}/VifRoutes(${vif.virtualInterfaceId}) FAILED:`, msg);
      }
    }));
    console.log(
      `[AWS] ${region}/VifRoutes: ${regionVifs.length} VIFs queried → ${
        regionVifs.filter((v) => result.has(v.virtualInterfaceId)).length
      } with routes${failed > 0 ? `, ${failed} failed` : ''}`,
    );
  }));

  return result;
}

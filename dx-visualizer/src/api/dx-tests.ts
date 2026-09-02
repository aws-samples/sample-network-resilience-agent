import type { AwsCredentials, DxVirtualInterface, VifFailoverTest } from '../types/aws-resources';
import { createDxClient } from './aws-client';
import { fetchVirtualInterfaceTestHistory } from './direct-connect';

/**
 * Fetch recorded BGP failover tests for every VIF, via
 * ListVirtualInterfaceTestHistory.
 *
 * Why this matters: every other signal in this app describes how redundancy is
 * *configured*. This is the only AWS-side evidence that it was ever actually
 * *exercised* — a customer with a perfect topology who has never failed over has
 * an untested design, and that distinction is invisible without this call.
 *
 * Deliberately NOT part of the login fetch: one paginated call per VIF, and the
 * answer only changes when someone runs a test. Same on-demand contract as
 * dx-routes.ts.
 *
 * Unlike routes, this is queried for VIFs in ANY state. A VIF that is currently
 * down still has a test history, and a down VIF is exactly when you want to know
 * whether failover was ever validated.
 *
 * Per-VIF failures (AccessDenied on one cross-account VIF) degrade to an omitted
 * map entry rather than failing the batch. Callers MUST treat a missing entry as
 * "unknown", not as "never tested" — see ruleDxFailoverTesting.
 */
export async function fetchVifFailoverTests(
  creds: AwsCredentials,
  vifs: DxVirtualInterface[],
): Promise<Map<string, VifFailoverTest[]>> {
  const result = new Map<string, VifFailoverTest[]>();
  if (vifs.length === 0) return result;

  const byRegion = new Map<string, DxVirtualInterface[]>();
  for (const vif of vifs) {
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
        const tests = await fetchVirtualInterfaceTestHistory(client, vif.virtualInterfaceId);
        // An empty array is a real answer here ("queried, no tests on record"),
        // unlike dx-routes where empty means nothing useful. Keep the entry so
        // the rule can distinguish it from a VIF we failed to query at all.
        result.set(vif.virtualInterfaceId, tests);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[AWS] ${region}/VifTests(${vif.virtualInterfaceId}) FAILED:`, msg);
      }
    }));
    const withTests = regionVifs.filter(
      (v) => (result.get(v.virtualInterfaceId)?.length ?? 0) > 0,
    ).length;
    console.log(
      `[AWS] ${region}/VifTests: ${regionVifs.length} VIFs queried → ${withTests} with recorded tests${
        failed > 0 ? `, ${failed} failed` : ''
      }`,
    );
  }));

  return result;
}

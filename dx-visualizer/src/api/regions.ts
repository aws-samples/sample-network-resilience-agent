import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

/**
 * Fetches region code → friendly name from AWS SSM public parameters for the
 * given region codes only.
 *
 * Earlier versions used `GetParametersByPath` with Recursive=true against
 * `/aws/service/global-infrastructure/regions`. That path expands to tens of
 * thousands of sub-parameters (region × service × endpoint) and the public-
 * parameter `MaxResults` cap of 10 made it paginate into thousands of calls
 * that stalled topology load after sign-in.
 *
 * Instead, we use `GetParameters` (up to 10 names per call) against the exact
 * `/aws/service/global-infrastructure/regions/<code>/longName` leaves for the
 * regions the caller actually discovered. Typical topologies touch 1–3 regions.
 *
 * Returns an empty Map on failure (e.g. missing ssm:GetParameters).
 */
export async function fetchRegionNames(
  client: SSMClient,
  regionCodes: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(regionCodes.filter(Boolean))];
  if (unique.length === 0) return result;

  const names = unique.map((code) => `/aws/service/global-infrastructure/regions/${code}/longName`);
  const codeByName = new Map(names.map((n, i) => [n, unique[i]]));

  try {
    // GetParameters accepts up to 10 names per call.
    for (let i = 0; i < names.length; i += 10) {
      const batch = names.slice(i, i + 10);
      const resp = await client.send(new GetParametersCommand({ Names: batch }));
      for (const p of resp.Parameters ?? []) {
        const code = codeByName.get(p.Name ?? '');
        const value = p.Value ?? '';
        if (code && value) result.set(code, simplifyLongName(value));
      }
    }
  } catch (err) {
    console.warn('[AWS] SSM region-name fetch FAILED:', err instanceof Error ? err.message : err);
    return new Map();
  }

  return result;
}

/**
 * SSM returns long names like "Asia Pacific (Osaka)" / "US East (N. Virginia)".
 * We want just the city portion to keep the "Osaka region" UI format the app uses.
 */
function simplifyLongName(longName: string): string {
  const match = longName.match(/\(([^)]+)\)\s*$/);
  if (match) return match[1].trim();
  return longName;
}

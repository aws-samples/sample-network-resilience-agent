// Shared constants and types used across the application.

/** AWS region code to display name mapping (used by Price List API filters). */
export const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-central-1': 'EU (Frankfurt)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'sa-east-1': 'South America (Sao Paulo)',
  'ca-central-1': 'Canada (Central)',
  'me-south-1': 'Middle East (Bahrain)',
  'af-south-1': 'Africa (Cape Town)',
};

/** Ordered list of AWS Direct Connect resiliency tiers from lowest to highest. */
export const RESILIENCY_TIERS = ['none', 'devtest', 'high', 'maximum'] as const;

/** Mock scenario identifiers for demo mode. */
export type MockScenario = 'noResiliency' | 'devTest' | 'high' | 'maximum' | 'crossAccount';

/** Default welcome message shown in the chat panel. */
export const WELCOME_MESSAGE =
  'I can see your Direct Connect topology. Ask me anything about improving resiliency or best practices.';

// Accepts the bandwidth strings AWS uses for connections, LAGs, and VIF rate
// limits: "50Mbps", "1.2Gbps", "1.6Tbps". Tbps matters — DX VIF rate limits and
// large LAGs go up to 1.6Tbps, and without a T case those parsed as undefined,
// which silently hides the utilization bar instead of showing a percentage.
export function parseBandwidthToBps(bw?: string): number | undefined {
  if (!bw) return undefined;
  const m = bw.match(/^\s*(\d+(?:\.\d+)?)\s*(T|G|M|K)?bps\s*$/i);
  if (!m) return undefined;
  const value = parseFloat(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  const mult = unit === 'T' ? 1e12 : unit === 'G' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return value * mult;
}

export function formatBps(bps: number): string {
  if (bps >= 1e12) return `${(bps / 1e12).toFixed(2)} Tbps`;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kbps`;
  return `${bps.toFixed(0)} bps`;
}

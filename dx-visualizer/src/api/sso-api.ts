// Reject anything that isn't HTTPS, except http://localhost / 127.0.0.1 for dev.
// Prevents an attacker who can write localStorage from redirecting SSO traffic
// (and the AWS credentials it returns) to an arbitrary server.
function isAllowedBackendUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return true;
  return false;
}

function sanitizeBackendUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.replace(/\/+$/, '');
  return isAllowedBackendUrl(trimmed) ? trimmed : '';
}

const getBackendUrl = (): string => {
  const envUrl = import.meta.env.VITE_SSO_BACKEND_URL as string | undefined;
  const fromEnv = sanitizeBackendUrl(envUrl);
  if (fromEnv) return fromEnv;
  return sanitizeBackendUrl(localStorage.getItem('ssoBackendUrl'));
};

export function getSavedBackendUrl(): string {
  return sanitizeBackendUrl(localStorage.getItem('ssoBackendUrl'));
}

export function saveBackendUrl(url: string) {
  const trimmed = url.replace(/\/+$/, '');
  if (!isAllowedBackendUrl(trimmed)) {
    throw new Error('Backend URL must be HTTPS (or http://localhost for dev)');
  }
  localStorage.setItem('ssoBackendUrl', trimmed);
}

// Build an actionable message for the case where fetch() rejects outright —
// i.e. the request never reached an HTTP response. The overwhelmingly common
// cause is that the SSO backend isn't running (or the Backend URL points
// somewhere with nothing listening / blocked by CORS).
function describeUnreachableBackend(base: string): string {
  let isLocal = false;
  try {
    const host = new URL(base).hostname;
    isLocal = host === 'localhost' || host === '127.0.0.1';
  } catch {
    /* base is validated upstream; fall back to the remote phrasing */
  }
  const fix = isLocal
    ? "It looks like it isn't running — start it with `cd backend && npm run dev`, then try again."
    : 'Check that the backend is deployed and reachable, and that the Backend URL is correct, then try again.';
  return `Couldn't reach the SSO backend at ${base}. ${fix}`;
}

async function post<T>(path: string, body: Record<string, unknown>, backendUrl?: string): Promise<T> {
  const base = backendUrl?.replace(/\/+$/, '') || getBackendUrl();
  if (!base) throw new Error('SSO backend URL is not configured');

  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forces a CORS preflight on cross-origin requests, so a malicious
        // site can't POST to this backend via a plain <form> or a fetch()
        // without this header. The backend rejects any request missing it.
        'X-Requested-By': 'resilience-agent',
      },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch() rejects only on a network-level failure (connection refused,
    // DNS, CORS) — never for a 4xx/5xx, which still resolve. Translate the
    // browser's opaque "Failed to fetch" into something the user can act on.
    throw new Error(describeUnreachableBackend(base));
  }

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error ?? `Request failed: ${resp.status}`);
  return data as T;
}

export interface SsoStartResult {
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface SsoPollResult {
  status: 'pending' | 'success';
  accessToken?: string;
  expiresIn?: number;
}

export interface SsoAccount {
  accountId: string;
  accountName: string;
  emailAddress: string;
}

export interface SsoRole {
  roleName: string;
  accountId: string;
}

export interface SsoCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: number;
}

export function ssoStart(startUrl: string, ssoRegion: string, backendUrl?: string) {
  return post<SsoStartResult>('/auth/sso/start', { startUrl, ssoRegion }, backendUrl);
}

export function ssoPoll(ssoRegion: string, clientId: string, deviceCode: string, backendUrl?: string) {
  return post<SsoPollResult>('/auth/sso/poll', { ssoRegion, clientId, deviceCode }, backendUrl);
}

export function ssoListAccounts(ssoRegion: string, accessToken: string, backendUrl?: string) {
  return post<{ accounts: SsoAccount[] }>('/auth/sso/accounts', { ssoRegion, accessToken }, backendUrl);
}

export function ssoListRoles(ssoRegion: string, accessToken: string, accountId: string, backendUrl?: string) {
  return post<{ roles: SsoRole[] }>('/auth/sso/roles', { ssoRegion, accessToken, accountId }, backendUrl);
}

export function ssoConnect(ssoRegion: string, accessToken: string, accountId: string, roleName: string, backendUrl?: string) {
  return post<SsoCredentials>('/auth/sso/connect', { ssoRegion, accessToken, accountId, roleName }, backendUrl);
}

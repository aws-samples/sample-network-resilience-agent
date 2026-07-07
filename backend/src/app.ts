import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import {
  registerClient,
  startDeviceAuth,
  pollForToken,
  listAccounts,
  listAccountRoles,
  getRoleCredentials,
} from './sso-service.js';

export const app = express();

// ----- CORS -----
// Origin allowlist comes from the ALLOWED_ORIGINS env var (comma-separated).
// /auth/sso/connect returns temporary IAM role credentials in the response
// body, so a wildcard policy would let any website the user visits exfiltrate
// credentials via a cross-origin POST. We fail-closed in production if the
// env var is missing, and allow the Vite dev server origin only when
// NODE_ENV != 'production' so `npm run dev` still works locally.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const isProd = process.env.NODE_ENV === 'production';

if (isProd && allowedOrigins.length === 0) {
  throw new Error(
    'ALLOWED_ORIGINS env var is required in production. Set it to a comma-separated list of SPA origins (e.g. "https://app.example.com").',
  );
}

const devOrigins = isProd ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'];
const originAllowlist = new Set<string>([...allowedOrigins, ...devOrigins]);

app.use(
  cors({
    // Requests without an Origin header (curl, server-to-server, health
    // probes) are not subject to the SOP in the first place — let them
    // through. Browser cross-origin requests always include Origin.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (originAllowlist.has(origin)) return cb(null, true);
      // cb(null, false) returns the response without CORS headers, which the
      // browser blocks client-side. Avoids throwing, which would 500 and leak
      // the allowlist via the error body.
      return cb(null, false);
    },
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-By'],
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 3600,
  }),
);
app.use(express.json());

function friendlyError(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === 'InvalidRequestException' || e.name === 'InvalidClientException') {
    return `Invalid SSO configuration: ${e.message}`;
  }
  if (e.name === 'UnauthorizedClientException') {
    return 'SSO client is not authorized. Check your Start URL and region.';
  }
  if (e.code === 'ENOTFOUND' || e.code === 'ERR_INVALID_URL') {
    return 'Could not reach AWS SSO endpoint. Check that the selected region is correct.';
  }
  if (e.name === 'ExpiredTokenException') {
    return 'Session expired. Please start the SSO flow again.';
  }
  if (e.message) return e.message;
  return 'Unknown error';
}

// Server-side store for OIDC client secrets – never sent to the browser.
// Entries are evicted on successful token exchange, on expiry, or after a TTL.
const clientSecrets = new Map<string, string>();
const CLIENT_SECRET_TTL_MS = 15 * 60 * 1000; // covers the SSO device-auth window

function rememberClientSecret(clientId: string, clientSecret: string) {
  clientSecrets.set(clientId, clientSecret);
  setTimeout(() => clientSecrets.delete(clientId), CLIENT_SECRET_TTL_MS).unref?.();
}

// Per-clientId minimum interval between /auth/sso/poll calls. AWS returns an
// `interval` (seconds) from StartDeviceAuthorization; polling faster than that
// is what produces SlowDownException. We enforce it server-side so a buggy or
// malicious frontend can't exhaust SSO OIDC quota.
const POLL_MIN_INTERVAL_MS = 5_000;
const lastPollAt = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - CLIENT_SECRET_TTL_MS;
  for (const [id, ts] of lastPollAt) if (ts < cutoff) lastPollAt.delete(id);
}, 5 * 60 * 1000).unref?.();

// Coarse IP-based guard for the SSO endpoints. Per-clientId throttling (above)
// is the precise control; this is defense-in-depth against unauthenticated
// spray traffic from a single origin. Mounted on the /auth/sso subtree below
// so every SSO route — including credential-returning ones — is covered.
const ssoLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many SSO requests, slow down.' },
});

// Custom-header gate: forces browsers to send a CORS preflight, so a cross-
// origin `<form>` POST or `fetch()` without this header is rejected by our
// CORS policy before the route handler runs. Pairs with the Origin allowlist
// — CSRF mitigation for the credential-returning endpoints. Anything that
// passes the CORS preflight and carries the header is considered a deliberate
// request from an allowlisted SPA origin (or a non-browser client we're not
// trying to defend against here).
const REQUESTED_BY_HEADER = 'x-requested-by';
const REQUESTED_BY_VALUE = 'resilience-agent';

function requireRequestedByHeader(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS') return next();
  if (req.header(REQUESTED_BY_HEADER) !== REQUESTED_BY_VALUE) {
    res.status(403).json({ error: 'Missing or invalid X-Requested-By header.' });
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Apply rate limit + CSRF header gate to every /auth/sso route, so new
// endpoints inherit the protections automatically instead of each one having
// to remember.
app.use('/auth/sso', ssoLimiter, requireRequestedByHeader);

app.post('/auth/sso/start', async (req, res) => {
  try {
    // Express 5 leaves req.body as undefined when no JSON body is parsed
    // (v4 defaulted to {}). Fall back so missing-field validation returns 400
    // rather than a destructure TypeError → 500.
    const { startUrl, ssoRegion } = req.body ?? {};
    if (!startUrl || !ssoRegion) {
      res.status(400).json({ error: 'startUrl and ssoRegion are required' });
      return;
    }
    const registration = await registerClient(ssoRegion);
    const deviceAuth = await startDeviceAuth(
      ssoRegion,
      registration.clientId,
      registration.clientSecret,
      startUrl
    );
    rememberClientSecret(registration.clientId, registration.clientSecret);
    res.json({
      clientId: registration.clientId,
      ...deviceAuth,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

app.post('/auth/sso/poll', async (req, res) => {
  const { ssoRegion, clientId, deviceCode } = req.body ?? {};
  try {
    if (!ssoRegion || !clientId || !deviceCode) {
      res.status(400).json({ error: 'ssoRegion, clientId, and deviceCode are required' });
      return;
    }
    const clientSecret = clientSecrets.get(clientId);
    if (!clientSecret) {
      res.status(400).json({ error: 'Unknown clientId. Please restart the SSO flow.' });
      return;
    }
    const now = Date.now();
    const last = lastPollAt.get(clientId);
    if (last !== undefined && now - last < POLL_MIN_INTERVAL_MS) {
      const retryAfterSec = Math.ceil((POLL_MIN_INTERVAL_MS - (now - last)) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ status: 'pending', error: 'Polling too fast. Wait before retrying.' });
      return;
    }
    lastPollAt.set(clientId, now);
    const result = await pollForToken(ssoRegion, clientId, clientSecret, deviceCode);
    // Only drop the secret when we're done with this flow — i.e. token issued.
    // While the user is still completing the browser flow, pollForToken returns
    // `{status:'pending'}` and we need the secret for the next poll.
    if (result.status === 'success') {
      clientSecrets.delete(clientId);
      lastPollAt.delete(clientId);
    }
    res.json(result);
  } catch (err: unknown) {
    const e = err as { name?: string };
    // AuthorizationPendingException / SlowDownException are transient — keep the secret.
    // Everything else is terminal for this device code; drop the secret.
    if (clientId && e.name !== 'AuthorizationPendingException' && e.name !== 'SlowDownException') {
      clientSecrets.delete(clientId);
      lastPollAt.delete(clientId);
    }
    const status = e.name === 'ExpiredTokenException' ? 410 : 500;
    res.status(status).json({ error: friendlyError(err) });
  }
});

app.post('/auth/sso/accounts', async (req, res) => {
  try {
    const { ssoRegion, accessToken } = req.body ?? {};
    if (!ssoRegion || !accessToken) {
      res.status(400).json({ error: 'ssoRegion and accessToken are required' });
      return;
    }
    const accounts = await listAccounts(ssoRegion, accessToken);
    res.json({ accounts });
  } catch (err: unknown) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

app.post('/auth/sso/roles', async (req, res) => {
  try {
    const { ssoRegion, accessToken, accountId } = req.body ?? {};
    if (!ssoRegion || !accessToken || !accountId) {
      res.status(400).json({ error: 'ssoRegion, accessToken, and accountId are required' });
      return;
    }
    const roles = await listAccountRoles(ssoRegion, accessToken, accountId);
    res.json({ roles });
  } catch (err: unknown) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

app.post('/auth/sso/connect', async (req, res) => {
  try {
    const { ssoRegion, accessToken, accountId, roleName } = req.body ?? {};
    if (!ssoRegion || !accessToken || !accountId || !roleName) {
      res.status(400).json({ error: 'ssoRegion, accessToken, accountId, and roleName are required' });
      return;
    }
    const credentials = await getRoleCredentials(ssoRegion, accessToken, accountId, roleName);
    res.set('Cache-Control', 'no-store');
    res.json(credentials);
  } catch (err: unknown) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

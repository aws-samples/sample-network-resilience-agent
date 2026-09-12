// Input validation for the /auth/sso subtree.
//
// WHY THIS EXISTS — do not "simplify" it away:
// `ssoRegion` is passed straight to `new SSOOIDCClient({ region })` /
// `new SSOClient({ region })` in sso-service.ts. The AWS SDK v3 does NOT reject
// an unknown region — it falls through to the default `aws` partition and
// substitutes the value into the endpoint rule `https://oidc.{Region}.{dnsSuffix}`
// **without URL-encoding it**. Because {Region} lands in the HOST portion, a
// region of `@evil.example/` resolves to the host `evil.example`, which sends the
// OIDC clientSecret, the deviceCode and — worse — the bearer accessToken to an
// attacker-controlled endpoint. A presence-only check (`if (!ssoRegion)`) does
// not stop that. `startUrl` is the same class of problem: it is handed to
// StartDeviceAuthorization and shown to the user as the portal to sign in to.
//
// So: validate the *shape* of every attacker-influenced field at the edge,
// before it can reach an SDK client constructor.

import type { Request, Response, NextFunction } from 'express';

// Standard AWS region form: two letters, one or more lowercase words, a 1-2
// digit index (us-east-1, ap-southeast-7, us-gov-west-1, eu-central-1).
export const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

// These two are deliberately IDENTICAL to the frontend regexes in
// dx-visualizer/src/api/organizations.ts:68 (account ID) and :72 (role name),
// so both layers agree on what they accept. The code cannot be shared: backend/
// and dx-visualizer/ are separate workspaces with their own package.json and
// node_modules, and there is no shared package. If you change one, change both.
export const ACCOUNT_ID_RE = /^\d{12}$/;
export const ROLE_NAME_RE = /^[\w+=,.@-]{1,64}$/;

// IAM Identity Center access portals live under *.awsapps.com (e.g.
// https://d-906614ba17.awsapps.com/start). The suffix list is overridable via
// SSO_ALLOWED_START_URL_HOSTS (comma-separated) because customers can front the
// portal with a custom domain, and some isolated partitions do not use
// awsapps.com at all — an operator must be able to widen this without forking
// the code. Read per call so the value is configurable at runtime and testable.
const DEFAULT_START_URL_HOSTS = ['awsapps.com'];

function allowedStartUrlHosts(): string[] {
  const configured = (process.env.SSO_ALLOWED_START_URL_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_START_URL_HOSTS;
}

export function isValidStartUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // Blocks https://user:pw@evil.example/start — userinfo makes the real host
  // easy to miss when the value is read by a human or logged.
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return allowedStartUrlHosts().some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function matches(re: RegExp, value: unknown): boolean {
  return typeof value === 'string' && re.test(value);
}

export function isValidSsoRegion(value: unknown): boolean {
  return matches(AWS_REGION_RE, value);
}

export function isValidAccountId(value: unknown): boolean {
  return matches(ACCOUNT_ID_RE, value);
}

export function isValidRoleName(value: unknown): boolean {
  return matches(ROLE_NAME_RE, value);
}

/**
 * Express middleware for the /auth/sso subtree. Validates the format of each
 * field it knows about, but ONLY if the field is present — required-field
 * checks stay in the route handlers, which return field-specific messages.
 *
 * Rejections never echo the offending value back, so a hostile input cannot be
 * reflected into the response body.
 */
export function validateSsoInput(req: Request, res: Response, next: NextFunction) {
  // Express 5 leaves req.body as undefined when no JSON body is parsed
  // (v4 defaulted to {}) — see the same fallback in app.ts.
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (body.ssoRegion !== undefined && !isValidSsoRegion(body.ssoRegion)) {
    res.status(400).json({ error: 'Invalid ssoRegion format' });
    return;
  }
  if (body.accountId !== undefined && !isValidAccountId(body.accountId)) {
    res.status(400).json({ error: 'Invalid accountId format' });
    return;
  }
  if (body.roleName !== undefined && !isValidRoleName(body.roleName)) {
    res.status(400).json({ error: 'Invalid roleName format' });
    return;
  }
  if (body.startUrl !== undefined && !isValidStartUrl(body.startUrl)) {
    res.status(400).json({ error: 'Invalid startUrl format' });
    return;
  }

  next();
}

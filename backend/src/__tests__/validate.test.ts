import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  isValidSsoRegion,
  isValidAccountId,
  isValidRoleName,
  isValidStartUrl,
  validateSsoInput,
} from '../validate.js';

// The payload that motivates this whole file: the AWS SDK substitutes {Region}
// into the endpoint HOST without encoding, so "@evil.example/" produces
// https://oidc.@evil.example//… → host evil.example, and the OIDC secret plus
// the bearer accessToken go to the attacker.
const REGION_REJECT: [string, unknown][] = [
  ['host injection via userinfo', '@evil.example/'],
  ['path separator', 'x/'],
  ['uppercase', 'US-EAST-1'],
  ['too short / no parts', 'us'],
  ['path traversal prefix', '../us-east-1'],
  ['empty string', ''],
  ['non-string object', {}],
  ['non-string array', ['us-east-1']],
  ['non-string number', 1],
];

const REGION_ACCEPT = ['us-east-1', 'ap-southeast-1', 'eu-west-2', 'ap-southeast-7'];

const ACCOUNT_REJECT: [string, unknown][] = [
  ['11 digits', '12345'],
  ['13 digits', '1234567890123'],
  ['12 chars with a letter', '12345678901a'],
  ['non-string', 123456789012],
];

const LONG_ROLE_NAME = 'a'.repeat(65);

const ROLE_REJECT: [string, unknown][] = [
  ['65 characters', LONG_ROLE_NAME],
  ['contains a path separator', 'path/RoleName'],
  ['empty string', ''],
  ['non-string', {}],
];

const START_URL_REJECT: [string, unknown][] = [
  ['plain http', 'http://evil.example/start'],
  ['userinfo smuggling the real host', 'https://user:pw@evil.example/start'],
  ['host outside the allowlist', 'https://evil.example/start'],
  ['suffix lookalike', 'https://awsapps.com.evil.example/start'],
  ['not a URL at all', 'not a url'],
  ['non-string', {}],
];

const START_URL_ACCEPT = [
  'https://d-906614ba17.awsapps.com/start',
  'https://mycompany.awsapps.com/start',
];

describe('field predicates', () => {
  it.each(REGION_REJECT)('rejects ssoRegion (%s)', (_label, value) => {
    expect(isValidSsoRegion(value)).toBe(false);
  });

  it.each(REGION_ACCEPT)('accepts ssoRegion %s', (value) => {
    expect(isValidSsoRegion(value)).toBe(true);
  });

  it.each(ACCOUNT_REJECT)('rejects accountId (%s)', (_label, value) => {
    expect(isValidAccountId(value)).toBe(false);
  });

  it('accepts a 12-digit accountId', () => {
    expect(isValidAccountId('123456789012')).toBe(true);
  });

  it.each(ROLE_REJECT)('rejects roleName (%s)', (_label, value) => {
    expect(isValidRoleName(value)).toBe(false);
  });

  it('accepts a normal roleName', () => {
    expect(isValidRoleName('NetworkReadOnlyRole')).toBe(true);
  });

  it('accepts a 64-character roleName but not a 65-character one', () => {
    expect(isValidRoleName('a'.repeat(64))).toBe(true);
    expect(isValidRoleName('a'.repeat(65))).toBe(false);
  });

  it.each(START_URL_REJECT)('rejects startUrl (%s)', (_label, value) => {
    expect(isValidStartUrl(value)).toBe(false);
  });

  it.each(START_URL_ACCEPT)('accepts startUrl %s', (value) => {
    expect(isValidStartUrl(value)).toBe(true);
  });
});

describe('SSO_ALLOWED_START_URL_HOSTS', () => {
  afterEach(() => {
    delete process.env.SSO_ALLOWED_START_URL_HOSTS;
  });

  it('widens the allowlist to the configured suffixes', () => {
    process.env.SSO_ALLOWED_START_URL_HOSTS = 'sso.example.com , portal.example.net';
    expect(isValidStartUrl('https://sso.example.com/start')).toBe(true);
    expect(isValidStartUrl('https://eu.portal.example.net/start')).toBe(true);
  });

  it('replaces the default rather than adding to it', () => {
    process.env.SSO_ALLOWED_START_URL_HOSTS = 'sso.example.com';
    expect(isValidStartUrl('https://d-906614ba17.awsapps.com/start')).toBe(false);
  });

  it('falls back to the awsapps.com default when set to an empty value', () => {
    process.env.SSO_ALLOWED_START_URL_HOSTS = ' , ';
    expect(isValidStartUrl('https://d-906614ba17.awsapps.com/start')).toBe(true);
  });

  it('still requires https for an overridden host', () => {
    process.env.SSO_ALLOWED_START_URL_HOSTS = 'sso.example.com';
    expect(isValidStartUrl('http://sso.example.com/start')).toBe(false);
  });
});

function runMiddleware(body: unknown) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  const res = { status, json } as unknown as Response;
  validateSsoInput({ body } as Request, res, next as unknown as NextFunction);
  return { status, json, next };
}

describe('validateSsoInput', () => {
  it('calls next() when no known field is present', () => {
    // Required-field checks belong to the route handlers, not here.
    const { next, status } = runMiddleware({ accessToken: 'tok' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('calls next() for an undefined body (Express 5 leaves it unset)', () => {
    const { next, status } = runMiddleware(undefined);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('calls next() for a fully valid payload', () => {
    const { next, status } = runMiddleware({
      ssoRegion: 'ap-southeast-1',
      accountId: '123456789012',
      roleName: 'NetworkReadOnlyRole',
      startUrl: 'https://d-906614ba17.awsapps.com/start',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a hostile ssoRegion with 400 and does not call next()', () => {
    const { next, status, json } = runMiddleware({
      startUrl: 'https://d-906614ba17.awsapps.com/start',
      ssoRegion: '@evil.example/',
    });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid ssoRegion format' });
  });

  it('does not echo the offending value back in the response body', () => {
    const { json } = runMiddleware({ ssoRegion: '@evil.example/' });
    const serialized = JSON.stringify(json.mock.calls);
    expect(serialized).not.toContain('evil.example');
  });

  it.each([
    ['ssoRegion', { ssoRegion: 'x/' }],
    ['accountId', { accountId: '12345' }],
    ['roleName', { roleName: LONG_ROLE_NAME }],
    ['startUrl', { startUrl: 'http://evil.example/start' }],
  ])('names the offending field for %s', (field, body) => {
    const { next, status, json } = runMiddleware(body);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: `Invalid ${field} format` });
  });

  it('rejects a present-but-non-string field instead of throwing', () => {
    expect(() => runMiddleware({ ssoRegion: {} })).not.toThrow();
    const { status, json } = runMiddleware({ ssoRegion: ['us-east-1'] });
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid ssoRegion format' });
  });
});

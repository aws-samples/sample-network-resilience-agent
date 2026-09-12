import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} from '@aws-sdk/client-sso-oidc';
import {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  GetRoleCredentialsCommand,
} from '@aws-sdk/client-sso';

// Hard page ceiling for every paginated SSO call below. A response that hands
// back a non-empty nextToken on every page — a malformed or hostile endpoint —
// otherwise loops until the Lambda times out, with the accumulator growing the
// whole time. 1000 is generous by orders of magnitude: ListAccounts returns up
// to 100 accounts per page and ListAccountRoles up to 100 roles, so this allows
// ~100k of either, far beyond any Identity Center assignment set. Breaching it
// means the API is misbehaving, not that a real tenant is large.
const MAX_PAGES = 1000;

function createOidcClient(ssoRegion: string) {
  return new SSOOIDCClient({
    region: ssoRegion,
    credentials: { accessKeyId: '', secretAccessKey: '' },
  });
}

function createSsoClient(ssoRegion: string) {
  return new SSOClient({
    region: ssoRegion,
    credentials: { accessKeyId: '', secretAccessKey: '' },
  });
}

export async function registerClient(ssoRegion: string) {
  const client = createOidcClient(ssoRegion);
  const resp = await client.send(
    new RegisterClientCommand({
      clientName: 'resilience-agent',
      clientType: 'public',
    })
  );
  return {
    clientId: resp.clientId!,
    clientSecret: resp.clientSecret!,
    clientSecretExpiresAt: resp.clientSecretExpiresAt!,
  };
}

export async function startDeviceAuth(
  ssoRegion: string,
  clientId: string,
  clientSecret: string,
  startUrl: string
) {
  const client = createOidcClient(ssoRegion);
  const resp = await client.send(
    new StartDeviceAuthorizationCommand({
      clientId,
      clientSecret,
      startUrl,
    })
  );
  return {
    deviceCode: resp.deviceCode!,
    userCode: resp.userCode!,
    verificationUri: resp.verificationUri!,
    verificationUriComplete: resp.verificationUriComplete!,
    expiresIn: resp.expiresIn!,
    interval: resp.interval ?? 5,
  };
}

export async function pollForToken(
  ssoRegion: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string
): Promise<{ status: 'pending' | 'success'; accessToken?: string; expiresIn?: number }> {
  const client = createOidcClient(ssoRegion);
  try {
    const resp = await client.send(
      new CreateTokenCommand({
        clientId,
        clientSecret,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        deviceCode,
      })
    );
    return {
      status: 'success',
      accessToken: resp.accessToken!,
      expiresIn: resp.expiresIn!,
    };
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === 'AuthorizationPendingException') {
      return { status: 'pending' };
    }
    if (error.name === 'SlowDownException') {
      return { status: 'pending' };
    }
    throw err;
  }
}

export async function listAccounts(ssoRegion: string, accessToken: string) {
  const client = createSsoClient(ssoRegion);
  const accounts: { accountId: string; accountName: string; emailAddress: string }[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const resp = await client.send(
      new ListAccountsCommand({ accessToken, nextToken })
    );
    for (const acct of resp.accountList ?? []) {
      accounts.push({
        accountId: acct.accountId!,
        accountName: acct.accountName ?? '',
        emailAddress: acct.emailAddress ?? '',
      });
    }
    nextToken = resp.nextToken;
    pages += 1;
    if (nextToken && pages >= MAX_PAGES) {
      throw new Error(`SSO ListAccounts exceeded ${MAX_PAGES} pages — aborting pagination.`);
    }
  } while (nextToken);

  return accounts;
}

export async function listAccountRoles(
  ssoRegion: string,
  accessToken: string,
  accountId: string
) {
  const client = createSsoClient(ssoRegion);
  const roles: { roleName: string; accountId: string }[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const resp = await client.send(
      new ListAccountRolesCommand({ accessToken, accountId, nextToken })
    );
    for (const role of resp.roleList ?? []) {
      roles.push({
        roleName: role.roleName!,
        accountId: role.accountId!,
      });
    }
    nextToken = resp.nextToken;
    pages += 1;
    if (nextToken && pages >= MAX_PAGES) {
      throw new Error(`SSO ListAccountRoles exceeded ${MAX_PAGES} pages — aborting pagination.`);
    }
  } while (nextToken);

  return roles;
}

export async function getRoleCredentials(
  ssoRegion: string,
  accessToken: string,
  accountId: string,
  roleName: string
) {
  const client = createSsoClient(ssoRegion);
  const resp = await client.send(
    new GetRoleCredentialsCommand({ accessToken, accountId, roleName })
  );
  const creds = resp.roleCredentials!;
  return {
    accessKeyId: creds.accessKeyId!,
    secretAccessKey: creds.secretAccessKey!,
    sessionToken: creds.sessionToken!,
    expiration: creds.expiration!,
  };
}

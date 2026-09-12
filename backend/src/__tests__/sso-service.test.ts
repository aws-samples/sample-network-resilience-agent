import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the SDK so we drive the paginated responses ourselves. `sso-service.ts`
// constructs its own SSOClient, so the client class itself has to be replaced —
// there is no injectable client to hand in.
const sendMock = vi.fn();

// Parameter properties are banned by this project's `erasableSyntaxOnly`, so
// these stubs assign in the body.
vi.mock('@aws-sdk/client-sso', () => {
  class SSOClient {
    send: (cmd: unknown) => Promise<unknown>;
    constructor(_config: unknown) {
      this.send = sendMock;
    }
  }
  class ListAccountsCommand {
    input: { accessToken?: string; nextToken?: string };
    constructor(input: { accessToken?: string; nextToken?: string }) {
      this.input = input;
    }
  }
  class ListAccountRolesCommand {
    input: { accessToken?: string; accountId?: string; nextToken?: string };
    constructor(input: { accessToken?: string; accountId?: string; nextToken?: string }) {
      this.input = input;
    }
  }
  class GetRoleCredentialsCommand {
    input: { accessToken?: string; accountId?: string; roleName?: string };
    constructor(input: { accessToken?: string; accountId?: string; roleName?: string }) {
      this.input = input;
    }
  }
  return { SSOClient, ListAccountsCommand, ListAccountRolesCommand, GetRoleCredentialsCommand };
});

const { ListAccountsCommand, ListAccountRolesCommand } = await import('@aws-sdk/client-sso');
const { listAccounts, listAccountRoles } = await import('../sso-service.js');

const REGION = 'us-east-1';
const TOKEN = 'access-token';

// Mirrors the module-local cap in sso-service.ts. Kept as a literal so a change
// to the production constant is a deliberate test update, not a silent one.
const MAX_PAGES = 1000;

function account(id: string) {
  return { accountId: id, accountName: `acct-${id}`, emailAddress: `${id}@example.com` };
}

describe('listAccounts pagination', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('aggregates across pages and terminates when nextToken clears', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      const c = cmd as { input: { nextToken?: string } };
      if (!(cmd instanceof ListAccountsCommand)) return Promise.resolve({});
      return c.input.nextToken
        ? Promise.resolve({ accountList: [account('222222222222')] })
        : Promise.resolve({ accountList: [account('111111111111')], nextToken: 'page2' });
    });

    const accounts = await listAccounts(REGION, TOKEN);

    expect(accounts.map((a) => a.accountId)).toEqual(['111111111111', '222222222222']);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  // The failure mode being closed: an endpoint that hands back a token on every
  // page previously looped until the Lambda timed out, growing the accumulator.
  it('throws instead of looping forever when nextToken never clears', async () => {
    sendMock.mockImplementation(() =>
      Promise.resolve({ accountList: [account('111111111111')], nextToken: 'again' }),
    );

    await expect(listAccounts(REGION, TOKEN)).rejects.toThrow(/ListAccounts exceeded 1000 pages/);
    expect(sendMock).toHaveBeenCalledTimes(MAX_PAGES);
  });
});

describe('listAccountRoles pagination', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('aggregates across pages and terminates when nextToken clears', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      const c = cmd as { input: { nextToken?: string } };
      if (!(cmd instanceof ListAccountRolesCommand)) return Promise.resolve({});
      return c.input.nextToken
        ? Promise.resolve({ roleList: [{ roleName: 'RoleB', accountId: '111111111111' }] })
        : Promise.resolve({
            roleList: [{ roleName: 'RoleA', accountId: '111111111111' }],
            nextToken: 'page2',
          });
    });

    const roles = await listAccountRoles(REGION, TOKEN, '111111111111');

    expect(roles.map((r) => r.roleName)).toEqual(['RoleA', 'RoleB']);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('throws instead of looping forever when nextToken never clears', async () => {
    sendMock.mockImplementation(() =>
      Promise.resolve({
        roleList: [{ roleName: 'RoleA', accountId: '111111111111' }],
        nextToken: 'again',
      }),
    );

    await expect(listAccountRoles(REGION, TOKEN, '111111111111')).rejects.toThrow(
      /ListAccountRoles exceeded 1000 pages/,
    );
    expect(sendMock).toHaveBeenCalledTimes(MAX_PAGES);
  });
});

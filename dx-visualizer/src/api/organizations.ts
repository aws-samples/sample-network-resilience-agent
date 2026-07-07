import { DescribeAccountCommand, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ListAccountAliasesCommand } from '@aws-sdk/client-iam';
import type { AwsCredentials } from '../types/aws-resources';
import { createIamClient, createOrganizationsClient, createStsClient } from './aws-client';

export interface OrgAccount {
  accountId: string;
  accountName: string;
  status: string;
}

/** List all active accounts in the AWS Organization. */
export async function listOrgAccounts(creds: AwsCredentials): Promise<OrgAccount[]> {
  const client = createOrganizationsClient(creds);
  const accounts: OrgAccount[] = [];
  let nextToken: string | undefined;

  do {
    const res = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
    for (const a of res.Accounts ?? []) {
      if (a.Status === 'ACTIVE' && a.Id) {
        accounts.push({
          accountId: a.Id,
          accountName: a.Name ?? a.Id,
          status: a.Status,
        });
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return accounts;
}

/**
 * Resolve a friendly name for the caller's account.
 * Tries Organizations DescribeAccount first (returns the real account name if
 * the caller has org-level permissions), then falls back to the IAM account
 * alias, then null.
 */
export async function resolveAccountName(
  creds: AwsCredentials,
  accountId: string,
): Promise<string | null> {
  try {
    const org = createOrganizationsClient(creds);
    const res = await org.send(new DescribeAccountCommand({ AccountId: accountId }));
    if (res.Account?.Name) return res.Account.Name;
  } catch { /* no org permissions — fall through */ }

  try {
    const iam = createIamClient(creds);
    const res = await iam.send(new ListAccountAliasesCommand({}));
    const alias = res.AccountAliases?.[0];
    if (alias) return alias;
  } catch { /* no iam:ListAccountAliases permission */ }

  return null;
}

/** Assume a role in a target account and return temporary credentials. */
export async function assumeRoleInAccount(
  creds: AwsCredentials,
  targetAccountId: string,
  roleName: string,
): Promise<AwsCredentials | null> {
  if (!/^\d{12}$/.test(targetAccountId)) {
    console.warn(`[AWS] Rejected invalid account ID: ${targetAccountId}`);
    return null;
  }
  if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) {
    console.warn(`[AWS] Rejected invalid role name: ${roleName}`);
    return null;
  }
  const stsClient = createStsClient(creds);
  const roleArn = `arn:aws:iam::${targetAccountId}:role/${roleName}`;

  try {
    const res = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `dx-visualizer-${targetAccountId}`,
        DurationSeconds: 900, // 15 minutes
      }),
    );

    const assumed = res.Credentials;
    if (!assumed?.AccessKeyId || !assumed.SecretAccessKey) return null;

    return {
      accessKeyId: assumed.AccessKeyId,
      secretAccessKey: assumed.SecretAccessKey,
      sessionToken: assumed.SessionToken,
      region: creds.region,
    };
  } catch (err) {
    console.warn(`[AWS] Failed to assume role in account ${targetAccountId}:`, err);
    return null;
  }
}

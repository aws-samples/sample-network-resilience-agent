import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GroupDefinition,
} from '@aws-sdk/client-cost-explorer';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { AwsCredentials } from '../types/aws-resources';

const CLIENT_CONFIG = {
  requestHandler: { requestTimeout: 15_000 },
};

function createCeClient(creds: AwsCredentials): CostExplorerClient {
  // Cost Explorer API is global — always uses us-east-1
  return new CostExplorerClient({
    ...CLIENT_CONFIG,
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/** Format a Date as YYYY-MM-DD */
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CostResult {
  accountId: string;
  timePeriod: { start: string; end: string };
  totalCost: number;
  currency: string;
  serviceBreakdown: { service: string; cost: number }[];
  notes: string;
}

/** Resolve the AWS account ID for the given credentials. */
async function resolveAccountId(creds: AwsCredentials): Promise<string> {
  try {
    const sts = new STSClient({
      region: creds.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Fetch Direct Connect and related networking costs for a given period.
 * Defaults to the last 30 days if no dates are provided.
 */
export async function fetchDxCosts(
  creds: AwsCredentials,
  startDate?: string,
  endDate?: string,
): Promise<CostResult> {
  const client = createCeClient(creds);
  const accountId = await resolveAccountId(creds);

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 86400000);

  const groupBy: GroupDefinition[] = [{ Type: 'DIMENSION', Key: 'SERVICE' }];

  const res = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: fmt(start), End: fmt(end) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      Filter: {
        Dimensions: {
          Key: 'SERVICE',
          Values: [
            'AWS Direct Connect',
            'Amazon Virtual Private Cloud',
            'AWS Site-to-Site VPN',
            'AWS Transit Gateway',
          ],
        },
      },
      GroupBy: groupBy,
    }),
  );

  const serviceMap = new Map<string, number>();

  for (const period of res.ResultsByTime ?? []) {
    for (const group of period.Groups ?? []) {
      const service = group.Keys?.[0] ?? 'Unknown';
      const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '0');
      serviceMap.set(service, (serviceMap.get(service) ?? 0) + amount);
    }
  }

  const serviceBreakdown = [...serviceMap.entries()]
    .map(([service, cost]) => ({ service, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);

  const totalCost = serviceBreakdown.reduce((sum, s) => sum + s.cost, 0);
  const currency = res.ResultsByTime?.[0]?.Groups?.[0]?.Metrics?.UnblendedCost?.Unit ?? 'USD';

  return {
    accountId,
    timePeriod: { start: fmt(start), end: fmt(end) },
    totalCost: Math.round(totalCost * 100) / 100,
    currency,
    serviceBreakdown,
    notes: `Actual costs from AWS Cost Explorer for account ${accountId}, period ${fmt(start)} to ${fmt(end)}. Covers Direct Connect, VPC, VPN, and Transit Gateway services. These costs reflect only this account — spoke account costs are not included.`,
  };
}

/**
 * Fetch daily cost breakdown for Direct Connect specifically.
 */
export async function fetchDxDailyCosts(
  creds: AwsCredentials,
  startDate?: string,
  endDate?: string,
): Promise<{ accountId: string; days: { date: string; cost: number }[] }> {
  const client = createCeClient(creds);
  const accountId = await resolveAccountId(creds);

  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 86400000);

  const res = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: fmt(start), End: fmt(end) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      Filter: {
        Dimensions: {
          Key: 'SERVICE',
          Values: ['AWS Direct Connect'],
        },
      },
    }),
  );

  const days = (res.ResultsByTime ?? []).map((period) => ({
    date: period.TimePeriod?.Start ?? '',
    cost: Math.round(parseFloat(period.Total?.UnblendedCost?.Amount ?? '0') * 100) / 100,
  }));

  return { accountId, days };
}

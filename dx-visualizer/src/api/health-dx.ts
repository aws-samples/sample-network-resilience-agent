import {
  DescribeEventsCommand,
  DescribeEventDetailsCommand,
  DescribeAffectedEntitiesCommand,
} from '@aws-sdk/client-health';
import type { AwsCredentials, DxMaintenanceEvent } from '../types/aws-resources';
import { createHealthClient } from './aws-client';

/** Safety valve so a malformed nextToken loop can never spin forever. */
const MAX_PAGES = 25;

/** Largest page the Health API accepts (all three Describe* calls). */
const PAGE_SIZE = 100;

/**
 * DescribeEventDetails accepts at most 10 event ARNs per call — it is a batch
 * API, NOT a paginated one, so a longer list is rejected rather than truncated.
 */
const EVENT_DETAILS_BATCH = 10;

/**
 * Drain a token-paginated Health call.
 *
 * Every Describe* call in this API returns a partial page plus a `nextToken`,
 * and callers that ignore the token lose data silently — no error, just a short
 * array that looks complete. Routing all of them through one helper means the
 * mistake can only be made once.
 */
async function drainPages<T>(
  label: string,
  fetchPage: (nextToken: string | undefined) => Promise<{ items: T[]; nextToken?: string }>,
): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const { items, nextToken: token } = await fetchPage(nextToken);
    all.push(...items);
    nextToken = token;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  if (nextToken) {
    console.warn(
      `[AWS] Health: stopped paging ${label} at ${MAX_PAGES} pages; some results may be missing`,
    );
  }

  return all;
}

/** Split a list into fixed-size batches for a batch (non-paginated) API. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Page through DescribeAffectedEntities until AWS stops handing back a token.
 *
 * This MUST paginate. The API caps a page at 10 entities and returns a
 * `nextToken` for the rest, and one call carries entities for *every* event ARN
 * in the filter — so the cap is shared across all of them, not per event. A
 * single unpaginated call therefore doesn't just truncate the tail: events that
 * sort last get ZERO entities and look unaffected, while an event straddling the
 * page boundary shows a partial list that reads as complete. Observed live
 * against a 5-event account: one call returned 10 of 18 entities, leaving two
 * events empty and silently dropping 5 of one event's 10 resources.
 */
async function fetchAllAffectedEntities(
  client: ReturnType<typeof createHealthClient>,
  eventArns: string[],
): Promise<{ eventArn?: string; entityValue?: string }[]> {
  return drainPages('affected entities', async (nextToken) => {
    const res = await client.send(
      new DescribeAffectedEntitiesCommand({
        filter: { eventArns },
        maxResults: PAGE_SIZE,
        nextToken,
      }),
    );
    return { items: res.entities ?? [], nextToken: res.nextToken };
  });
}

/**
 * How far back to look for `issue` events.
 *
 * Unlike scheduled changes, issues are past-dated and unbounded — an account
 * could have years of them, and without a floor the MAX_PAGES valve would silently
 * truncate an arbitrary slice. 90 days is long enough to cover "did an AWS-side
 * DX problem hit us recently" while keeping the result set small.
 *
 * Exported so the calendar's legend states the same window the fetch used,
 * instead of hardcoding a number that could drift out of step with it.
 */
export const ISSUE_LOOKBACK_DAYS = 90;

/**
 * `entityValue` strings that are sentinels, not resource IDs.
 *
 * DescribeAffectedEntities always answers — even when AWS holds no
 * resource-level mapping for the event — and when it has none it answers with a
 * placeholder string instead of omitting the entity:
 *
 *  - `UNKNOWN`     — region-wide (`PUBLIC`) events, which AWS never maps down to
 *                    one account's resources. Returned with no `entityArn` and no
 *                    `awsAccountId`.
 *  - `AWS_ACCOUNT` — `ACCOUNT_SPECIFIC` scope, but flagged at account level: AWS
 *                    confirms this account was hit and names no connection or VIF.
 *
 * Verified against a live DX estate: every `issue` event lands on one of these
 * two, and only `scheduledChange` events return real `dxcon-*`/`dxvif-*` values.
 * Letting a sentinel through renders it as a clickable resource chip, which is
 * how the calendar came to show a dead chip reading "UNKNOWN" — the string was
 * AWS's, but presenting it as a resource ID was ours. Callers that need to say
 * *why* the list is empty should branch on `eventScopeCode`, which is preserved.
 *
 * Exported so the UI can apply the same filter to snapshots captured before this
 * existed, which still carry the sentinels inside `affectedResourceIds`.
 */
export const NON_RESOURCE_ENTITY_VALUES: ReadonlySet<string> = new Set([
  'UNKNOWN',
  'AWS_ACCOUNT',
]);

/**
 * Fetch DX events, following pagination.
 *
 * Two different questions, so two different filters — a single combined call
 * cannot express them, because `eventStatusCodes` and the time window differ:
 *
 *  - scheduledChange: only `upcoming`/`open`, no time floor. Planned maintenance
 *    the customer can still act on.
 *  - issue: `closed` too, floored at ISSUE_LOOKBACK_DAYS. These are AWS-side DX
 *    problems that already happened — ground truth for whether the customer's
 *    redundancy was actually exercised. Almost all are closed by the time we ask,
 *    so omitting `closed` would return nearly nothing.
 *
 * `maxResults` is only a page size, never a total: an account with more events
 * than fit one page would otherwise have the remainder disappear from the
 * calendar.
 */
async function fetchAllEvents(client: ReturnType<typeof createHealthClient>) {
  const issueFloor = new Date(Date.now() - ISSUE_LOOKBACK_DAYS * 86_400_000);

  const [scheduled, issues] = await Promise.all([
    drainPages('scheduled changes', async (nextToken) => {
      const res = await client.send(
        new DescribeEventsCommand({
          filter: {
            services: ['DIRECTCONNECT'],
            eventTypeCategories: ['scheduledChange'],
            // Only currently-relevant events (upcoming or in-progress)
            eventStatusCodes: ['upcoming', 'open'],
          },
          maxResults: PAGE_SIZE,
          nextToken,
        }),
      );
      return { items: res.events ?? [], nextToken: res.nextToken };
    }),
    drainPages('issues', async (nextToken) => {
      const res = await client.send(
        new DescribeEventsCommand({
          filter: {
            services: ['DIRECTCONNECT'],
            eventTypeCategories: ['issue'],
            eventStatusCodes: ['open', 'upcoming', 'closed'],
            // Bounded, or an old account pages forever and hits MAX_PAGES.
            startTimes: [{ from: issueFloor }],
          },
          maxResults: PAGE_SIZE,
          nextToken,
        }),
      );
      return { items: res.events ?? [], nextToken: res.nextToken };
    }),
  ]);

  // Tag each event with its category so the UI can tell a planned change from an
  // outage that already happened. The two filters are disjoint, so no dedupe.
  return [
    ...scheduled.map((e) => ({ event: e, category: 'scheduledChange' as const })),
    ...issues.map((e) => ({ event: e, category: 'issue' as const })),
  ];
}

/**
 * Fetch descriptions for every event ARN, in batches.
 *
 * Unlike the other two calls this one is NOT paginated — it takes at most 10
 * event ARNs and rejects a longer list outright, so the ARNs must be chunked.
 */
async function fetchAllEventDetails(
  client: ReturnType<typeof createHealthClient>,
  eventArns: string[],
) {
  const batches = await Promise.all(
    chunk(eventArns, EVENT_DETAILS_BATCH).map((arns) =>
      client.send(new DescribeEventDetailsCommand({ eventArns: arns })),
    ),
  );
  return batches.flatMap((res) => res.successfulSet ?? []);
}

/**
 * Fetch scheduled AWS Direct Connect maintenance events via the AWS Health API.
 *
 * The Health API requires a Business, Enterprise On-Ramp, or Enterprise Support plan.
 * Accounts without a qualifying support plan will receive SubscriptionRequiredException
 * — we swallow the error and return an empty list so the UI simply hides the calendar.
 */
export async function fetchDxMaintenanceEvents(
  creds: AwsCredentials,
): Promise<DxMaintenanceEvent[]> {
  try {
    const client = createHealthClient(creds);

    const tagged = await fetchAllEvents(client);
    if (tagged.length === 0) {
      console.log('[AWS] Health: no Direct Connect maintenance events');
      return [];
    }

    const events = tagged.map((t) => t.event);
    const categoryByArn = new Map(
      tagged.filter((t) => !!t.event.arn).map((t) => [t.event.arn!, t.category]),
    );
    const eventArns = events.map((e) => e.arn).filter((a): a is string => !!a);

    // Fetch descriptions and affected entity IDs in parallel
    const [eventDetails, affectedEntities] = await Promise.all([
      fetchAllEventDetails(client, eventArns),
      fetchAllAffectedEntities(client, eventArns),
    ]);

    const descriptionByArn = new Map<string, string>();
    for (const detail of eventDetails) {
      if (detail.event?.arn && detail.eventDescription?.latestDescription) {
        descriptionByArn.set(detail.event.arn, detail.eventDescription.latestDescription);
      }
    }

    const entitiesByArn = new Map<string, string[]>();
    for (const ent of affectedEntities) {
      if (!ent.eventArn || !ent.entityValue) continue;
      // Keep sentinels out: they are AWS saying "no resource mapping", not an ID.
      if (NON_RESOURCE_ENTITY_VALUES.has(ent.entityValue)) continue;
      const list = entitiesByArn.get(ent.eventArn) ?? [];
      list.push(ent.entityValue);
      entitiesByArn.set(ent.eventArn, list);
    }

    const result: DxMaintenanceEvent[] = events
      .filter((e) => !!e.arn)
      .map((e) => ({
        arn: e.arn!,
        eventTypeCode: e.eventTypeCode ?? '',
        region: e.region ?? '',
        startTime: e.startTime ? new Date(e.startTime).toISOString() : undefined,
        endTime: e.endTime ? new Date(e.endTime).toISOString() : undefined,
        lastUpdatedTime: e.lastUpdatedTime ? new Date(e.lastUpdatedTime).toISOString() : undefined,
        statusCode: e.statusCode ?? '',
        affectedResourceIds: entitiesByArn.get(e.arn!) ?? [],
        description: descriptionByArn.get(e.arn!) ?? '',
        eventTypeCategory: categoryByArn.get(e.arn!),
        // Carried through so the calendar can tell a region-wide broadcast from
        // an event AWS attributes to this account — the two need opposite
        // treatment when no resource IDs come back.
        eventScopeCode: e.eventScopeCode as DxMaintenanceEvent['eventScopeCode'],
      }));

    const issueCount = result.filter((e) => e.eventTypeCategory === 'issue').length;
    // Scope is worth logging: PUBLIC events arrive for every region regardless of
    // footprint, so a surprising event count is usually region-wide noise rather
    // than something touching this account.
    const publicCount = result.filter((e) => e.eventScopeCode === 'PUBLIC').length;
    console.log(
      `[AWS] Health: ${result.length} Direct Connect event(s) — ${
        result.length - issueCount
      } scheduled change(s), ${issueCount} issue(s) in the last ${ISSUE_LOOKBACK_DAYS} days; ${publicCount} region-wide (PUBLIC)`,
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Accounts without Business/Enterprise support get SubscriptionRequiredException.
    // This is expected — log quietly and return empty so the UI hides the feature.
    if (/SubscriptionRequired/i.test(msg)) {
      console.log('[AWS] Health: skipping (requires Business/Enterprise support plan)');
    } else {
      console.warn('[AWS] Health: fetch failed:', msg);
    }
    return [];
  }
}

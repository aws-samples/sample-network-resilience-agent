import {
  DescribeEventsCommand,
  DescribeEventDetailsCommand,
  DescribeAffectedEntitiesCommand,
} from '@aws-sdk/client-health';
import type { AwsCredentials, DxMaintenanceEvent } from '../types/aws-resources';
import { createHealthClient } from './aws-client';

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

    const eventsRes = await client.send(
      new DescribeEventsCommand({
        filter: {
          services: ['DIRECTCONNECT'],
          eventTypeCategories: ['scheduledChange'],
          // Only currently-relevant events (upcoming or in-progress)
          eventStatusCodes: ['upcoming', 'open'],
        },
        maxResults: 50,
      }),
    );

    const events = eventsRes.events ?? [];
    if (events.length === 0) {
      console.log('[AWS] Health: no Direct Connect maintenance events');
      return [];
    }

    const eventArns = events.map((e) => e.arn).filter((a): a is string => !!a);

    // Fetch descriptions and affected entity IDs in parallel
    const [detailsRes, entitiesRes] = await Promise.all([
      client.send(new DescribeEventDetailsCommand({ eventArns })),
      client.send(new DescribeAffectedEntitiesCommand({ filter: { eventArns } })),
    ]);

    const descriptionByArn = new Map<string, string>();
    for (const detail of detailsRes.successfulSet ?? []) {
      if (detail.event?.arn && detail.eventDescription?.latestDescription) {
        descriptionByArn.set(detail.event.arn, detail.eventDescription.latestDescription);
      }
    }

    const entitiesByArn = new Map<string, string[]>();
    for (const ent of entitiesRes.entities ?? []) {
      if (!ent.eventArn || !ent.entityValue) continue;
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
      }));

    console.log(`[AWS] Health: ${result.length} Direct Connect maintenance event(s)`);
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

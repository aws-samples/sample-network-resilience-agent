import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the SDK command classes so we can assert on the params the caller builds
// and drive the paginated responses ourselves.
const sendMock = vi.fn();

vi.mock('../aws-client', () => ({
  createHealthClient: () => ({ send: sendMock }),
}));

// Parameter properties are banned by this project's `erasableSyntaxOnly`, so
// these stubs assign in the body.
vi.mock('@aws-sdk/client-health', () => {
  class DescribeEventsCommand {
    input: { maxResults?: number; nextToken?: string };
    constructor(input: { maxResults?: number; nextToken?: string }) {
      this.input = input;
    }
  }
  class DescribeEventDetailsCommand {
    input: { eventArns?: string[] };
    constructor(input: { eventArns?: string[] }) {
      this.input = input;
    }
  }
  class DescribeAffectedEntitiesCommand {
    input: { filter?: { eventArns?: string[] }; maxResults?: number; nextToken?: string };
    constructor(input: { filter?: { eventArns?: string[] }; maxResults?: number; nextToken?: string }) {
      this.input = input;
    }
  }
  return { DescribeEventsCommand, DescribeEventDetailsCommand, DescribeAffectedEntitiesCommand };
});

const { DescribeAffectedEntitiesCommand, DescribeEventsCommand, DescribeEventDetailsCommand } =
  await import('@aws-sdk/client-health');
const { fetchDxMaintenanceEvents } = await import('../health-dx');

const CREDS = { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', region: 'us-east-1' };

const ARN_A = 'arn:aws:health:ap-northeast-1::event/DIRECTCONNECT/X/A';
const ARN_B = 'arn:aws:health:ap-northeast-3::event/DIRECTCONNECT/X/B';

function event(arn: string, region: string) {
  return {
    arn,
    eventTypeCode: 'AWS_DIRECTCONNECT_MAINTENANCE_SCHEDULED',
    region,
    startTime: new Date('2026-07-30T13:00:00Z'),
    endTime: new Date('2026-07-30T15:00:00Z'),
    lastUpdatedTime: new Date('2026-07-23T12:00:00Z'),
    statusCode: 'upcoming',
  };
}

describe('fetchDxMaintenanceEvents', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  // The regression this pins: DescribeAffectedEntities caps a page at 10 entities
  // and the cap is shared across EVERY event ARN in the filter. Ignoring
  // nextToken doesn't just clip a tail — events that sort last come back with an
  // empty list and look unaffected, which is what shipped and hid two real
  // maintenance windows.
  it('follows nextToken so events beyond the first page keep their resources', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeEventsCommand) {
        return Promise.resolve({ events: [event(ARN_A, 'ap-northeast-1'), event(ARN_B, 'ap-northeast-3')] });
      }
      if (cmd instanceof DescribeEventDetailsCommand) {
        return Promise.resolve({ successfulSet: [] });
      }
      if (cmd instanceof DescribeAffectedEntitiesCommand) {
        // Page 1 fills up entirely with ARN_A's entities — ARN_B appears only
        // on page 2, exactly as observed against a live account.
        if (!cmd.input.nextToken) {
          return Promise.resolve({
            entities: [
              { eventArn: ARN_A, entityValue: 'dxcon-a1' },
              { eventArn: ARN_A, entityValue: 'dxvif-a2' },
            ],
            nextToken: 'page2',
          });
        }
        return Promise.resolve({
          entities: [
            { eventArn: ARN_A, entityValue: 'dxcon-a3' },
            { eventArn: ARN_B, entityValue: 'dxcon-b1' },
            { eventArn: ARN_B, entityValue: 'dxvif-b2' },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await fetchDxMaintenanceEvents(CREDS);

    const byArn = new Map(result.map((e) => [e.arn, e.affectedResourceIds]));
    expect(byArn.get(ARN_A)).toEqual(['dxcon-a1', 'dxvif-a2', 'dxcon-a3']);
    // Would be [] without pagination — the bug that hid the Osaka event.
    expect(byArn.get(ARN_B)).toEqual(['dxcon-b1', 'dxvif-b2']);
  });

  it('requests a full page rather than accepting the 10-entity default', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeEventsCommand) {
        return Promise.resolve({ events: [event(ARN_A, 'ap-northeast-1')] });
      }
      if (cmd instanceof DescribeEventDetailsCommand) return Promise.resolve({ successfulSet: [] });
      return Promise.resolve({ entities: [] });
    });

    await fetchDxMaintenanceEvents(CREDS);

    const call = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof DescribeAffectedEntitiesCommand) as
      | { input: { maxResults?: number } }
      | undefined;
    expect(call?.input.maxResults).toBe(100);
  });

  it('stops paging instead of looping forever when nextToken never clears', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeEventsCommand) {
        return Promise.resolve({ events: [event(ARN_A, 'ap-northeast-1')] });
      }
      if (cmd instanceof DescribeEventDetailsCommand) return Promise.resolve({ successfulSet: [] });
      // Always hands back a token — a malformed-pagination server.
      return Promise.resolve({ entities: [{ eventArn: ARN_A, entityValue: 'dxcon-a1' }], nextToken: 'again' });
    });

    const result = await fetchDxMaintenanceEvents(CREDS);

    const entityCalls = sendMock.mock.calls.filter(
      ([cmd]) => cmd instanceof DescribeAffectedEntitiesCommand,
    );
    expect(entityCalls.length).toBe(25);
    expect(result[0].affectedResourceIds.length).toBe(25);
  });

  // DescribeEvents is paginated too — maxResults is a page size, not a total.
  it('follows nextToken on DescribeEvents so later events are not dropped', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeEventsCommand) {
        return cmd.input.nextToken
          ? Promise.resolve({ events: [event(ARN_B, 'ap-northeast-3')] })
          : Promise.resolve({ events: [event(ARN_A, 'ap-northeast-1')], nextToken: 'more' });
      }
      if (cmd instanceof DescribeEventDetailsCommand) return Promise.resolve({ successfulSet: [] });
      return Promise.resolve({ entities: [] });
    });

    const result = await fetchDxMaintenanceEvents(CREDS);

    expect(result.map((e) => e.arn)).toEqual([ARN_A, ARN_B]);
  });

  // DescribeEventDetails is a BATCH api capped at 10 ARNs — it rejects a longer
  // list rather than truncating, so the ARNs must be chunked.
  it('chunks DescribeEventDetails into batches of at most 10 ARNs', async () => {
    const many = Array.from({ length: 23 }, (_, i) => `${ARN_A}-${i}`);
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeEventsCommand) {
        return Promise.resolve({ events: many.map((a) => event(a, 'ap-northeast-1')) });
      }
      if (cmd instanceof DescribeEventDetailsCommand) {
        const arns = cmd.input.eventArns ?? [];
        if (arns.length > 10) throw new Error(`too many ARNs: ${arns.length}`);
        return Promise.resolve({
          successfulSet: arns.map((arn) => ({
            event: { arn },
            eventDescription: { latestDescription: `desc ${arn}` },
          })),
        });
      }
      return Promise.resolve({ entities: [] });
    });

    const result = await fetchDxMaintenanceEvents(CREDS);

    const detailCalls = sendMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof DescribeEventDetailsCommand) as {
      input: { eventArns?: string[] };
    }[];
    expect(detailCalls.map((c) => c.input.eventArns?.length)).toEqual([10, 10, 3]);
    // Every event still gets its description — batching must not lose any.
    expect(result.length).toBe(23);
    expect(result.every((e) => e.description.startsWith('desc '))).toBe(true);
  });

  it('returns an empty list when the account lacks a qualifying support plan', async () => {
    sendMock.mockRejectedValue(new Error('SubscriptionRequiredException: ...'));
    await expect(fetchDxMaintenanceEvents(CREDS)).resolves.toEqual([]);
  });
});

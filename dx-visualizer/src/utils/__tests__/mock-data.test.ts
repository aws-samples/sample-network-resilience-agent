import { describe, it, expect } from 'vitest';
import { getMockTopology } from '../mock-data';

// Direct Connect maintenance is performed on an AWS logical device, so an event's
// blast radius is every connection terminating on that device plus every VIF
// riding those connections. The demo data used to hand-list one connection and
// one VIF for a device carrying four connections and three VIFs, which understated
// the impact in exactly the place a reader goes to check whether their redundancy
// survives the window.
describe('mock maintenance events', () => {
  const topology = getMockTopology('high');
  const events = topology.maintenanceEvents ?? [];

  const idsOnDevice = (logicalDeviceId: string) => {
    const connectionIds = topology.connections
      .filter((c) => c.awsLogicalDeviceId === logicalDeviceId)
      .map((c) => c.connectionId);
    const onDevice = new Set(connectionIds);
    const vifIds = topology.virtualInterfaces
      .filter((v) => v.awsLogicalDeviceId === logicalDeviceId || onDevice.has(v.connectionId))
      .map((v) => v.virtualInterfaceId);
    return { connectionIds, vifIds };
  };

  it('carries one scheduled change and one issue', () => {
    expect(events.map((e) => e.eventTypeCategory)).toEqual(['scheduledChange', 'issue']);
  });

  it.each([
    ['scheduledChange', 'EqSG2-lg1a'],
    ['issue', 'EqSG3-lg2a'],
  ])('%s covers every connection and VIF on %s', (category, logicalDeviceId) => {
    const event = events.find((e) => e.eventTypeCategory === category);
    expect(event).toBeDefined();
    const { connectionIds, vifIds } = idsOnDevice(logicalDeviceId);
    // Guard the fixture itself: a device with a single connection would make the
    // assertion below pass without proving anything.
    expect(connectionIds.length).toBeGreaterThan(1);
    expect(vifIds.length).toBeGreaterThan(1);
    expect([...event!.affectedResourceIds].sort()).toEqual([...connectionIds, ...vifIds].sort());
  });

  // Descriptions mirror the real PHD payload, which never lists the affected IDs
  // inline — the calendar surfaces `affectedResourceIds` as chips instead. Listing
  // them in the body also fed them to the prose ID-scanner, which truncates at the
  // first hyphen and so produced a dead `dxvif-high` chip for `dxvif-high-pub01`.
  it('keeps resource IDs out of the event descriptions', () => {
    for (const event of events) {
      expect(event.description).not.toMatch(/\bdx(?:con|vif|gw)-/);
    }
  });

  it('keeps the two events on different logical devices', () => {
    const [scheduled, issue] = events;
    const overlap = scheduled.affectedResourceIds.filter((id) =>
      issue.affectedResourceIds.includes(id),
    );
    expect(overlap).toEqual([]);
  });
});

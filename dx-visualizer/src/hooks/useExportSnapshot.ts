import { useCallback } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { config } from '../utils/config';
import { Sanitizer } from '../utils/sanitize';
import type { TopologyData } from '../types/topology';
import {
  serializeTopologyData,
  type SerializedView,
  type SerializedCustomizations,
  type SnapshotFile,
  type UtilizationWindowEntry,
  SNAPSHOT_SCHEMA_VERSION,
} from '../utils/snapshot';

function timestamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // The object URL is revoked on the next tick so the download has time to
  // start. Browsers cache the link element's href reference until the click
  // event finishes propagating.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface ExportSnapshotOptions {
  /**
   * When true, the topology is run through the deterministic Sanitizer before
   * serialization — every account ID, resource ID, IP/CIDR, ASN, name,
   * description, and tag value is replaced with a stable pseudo. The file
   * leaving the customer's machine then contains zero real customer
   * identifiers.
   *
   * When false, the topology is written verbatim. The file will contain real
   * AWS account IDs, VPC IDs, IPs, CIDRs, names, and tags. Caller is
   * responsible for surfacing this to the user.
   */
  sanitize: boolean;
  customerNote?: string;
}

export function useExportSnapshot() {
  return useCallback(async (opts: ExportSnapshotOptions) => {
    let state = useTopologyStore.getState();
    if (!state.topologyData) return;

    const activeWindow = state.utilizationWindowDays;

    // Auto-fetch utilization if it's missing. Without this, customers who
    // haven't clicked "Show Utilization" before exporting end up with a
    // snapshot containing zero metrics — the SA imports it, toggles
    // utilization, and sees nothing. This forces a CloudWatch fetch
    // on the customer's behalf so the file always carries data.
    //
    // Mock scenarios bake utilization into the fixture, so the cache may
    // be empty but topologyData.vifUtilization is already populated — skip
    // the fetch in that case.
    const hasInlineMetrics = !!(state.topologyData.vifUtilization?.size || state.topologyData.connectionUtilization?.size);
    const hasCachedMetrics = state.utilizationCache.size > 0;
    if (!hasInlineMetrics && !hasCachedMetrics && state.credentials && !state.useMock) {
      try {
        await state.loadUtilization(activeWindow);
        state = useTopologyStore.getState(); // re-read after fetch
      } catch (err) {
        // Soft-fail — continue exporting without metrics rather than blocking
        // the snapshot. The SA will see "no utilization in this snapshot".
        console.warn('Auto-fetch utilization for export failed; exporting without metrics', err);
      }
    }

    // Hydrate utilization onto topologyData from the store cache before
    // export. The customer may have fetched 30/60/90 windows in any order;
    // the *active* metrics live on topologyData, but we want every window
    // they ever fetched to ship in the snapshot so the SA can flip between
    // windows post-import without an AWS round-trip.
    const td = state.topologyData;
    if (!td) return;
    const cache = state.utilizationCache;
    const activeCached = cache.get(activeWindow);
    const enrichedTopology: TopologyData = {
      ...td,
      // Prefer the topology's existing maps (they're authoritative for the
      // active window when Show Utilization was on); fall back to the
      // cached entry if topologyData hasn't been stamped yet.
      vifUtilization: td.vifUtilization ?? activeCached?.vif,
      connectionUtilization: td.connectionUtilization ?? activeCached?.connection,
      utilizationWindowDays: td.utilizationWindowDays ?? activeWindow,
    };

    // Single Sanitizer instance so the topology's pseudo IDs match the
    // utilization cache's pseudo keys (and any other rewrites that flow
    // through the same maps).
    const sanitizer = opts.sanitize ? new Sanitizer() : null;
    const topology = sanitizer ? sanitizer.sanitizeTopology(enrichedTopology) : enrichedTopology;

    // Serialize the full cache, sanitizing each window's keys through the
    // same Sanitizer when applicable.
    const utilizationCache: UtilizationWindowEntry[] = [...cache.entries()].map(([window, entry]) => {
      const out = sanitizer ? sanitizer.utilizationWindow(entry) : entry;
      return [window, {
        vif: [...out.vif.entries()],
        connection: [...out.connection.entries()],
      }];
    });

    // If we shipped any utilization data, default the toggle to ON so the
    // SA sees metrics on first paint without having to click anything.
    const hasMetricsToShip =
      (enrichedTopology.vifUtilization?.size ?? 0) > 0 ||
      (enrichedTopology.connectionUtilization?.size ?? 0) > 0 ||
      utilizationCache.length > 0;

    const view: SerializedView = {
      viewMode: state.viewMode,
      showLiveStatus: state.showLiveStatus,
      showUtilization: state.showUtilization || hasMetricsToShip,
      utilizationWindowDays: state.utilizationWindowDays,
      focusedDxGatewayId: state.focusedDxGatewayId,
      resiliencyTargets: { ...state.resiliencyTargets },
      expandedVpcGroups: [...state.expandedVpcGroups],
      expandedTgwGroups: [...state.expandedTgwGroups],
      expandedPartnerGroups: [...state.expandedPartnerGroups],
      expandedIsolatedTgwGroups: [...state.expandedIsolatedTgwGroups],
      expandedTgwRoutePanels: [...state.expandedTgwRoutePanels],
      expandedVpcRoutePanels: [...state.expandedVpcRoutePanels],
      expandedVpcPeerPanels: [...state.expandedVpcPeerPanels],
      expandedCloudWanRoutePanels: [...state.expandedCloudWanRoutePanels],
      vpcGroupViewMode: [...state.vpcGroupViewMode.entries()],
      isolatedTgwGroupViewMode: [...state.isolatedTgwGroupViewMode.entries()],
      showVpcs: state.showVpcs,
      showNonDxVpcs: [...state.showNonDxVpcs],
      expandedUnattachedZone: state.expandedUnattachedZone,
      expandedHiddenAssocZone: state.expandedHiddenAssocZone,
      utilizationCache: utilizationCache.length > 0 ? utilizationCache : undefined,
    };

    const customizations: SerializedCustomizations = {
      userEdges: state.userEdges,
      hiddenEdgeIds: [...state.hiddenEdgeIds],
      edgeReconnectOverrides: [...state.edgeReconnectOverrides.entries()],
      userCustomerSites: state.userCustomerSites,
      hiddenCustomerSiteIds: [...state.hiddenCustomerSiteIds],
      userOnPremises: state.userOnPremises,
      hiddenOnPremiseIds: [...state.hiddenOnPremiseIds],
    };

    const file: SnapshotFile = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: config.appVersion,
      // The flag tracks whether the *file contents* are sanitized — that's
      // what the importer needs to know. Decoupled from the live UI redact
      // toggle, which is just a display mask.
      redactedView: opts.sanitize,
      customerNote: opts.customerNote,
      topology: serializeTopologyData(topology),
      view,
      customizations,
    };

    const json = JSON.stringify(file, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const suffix = opts.sanitize ? '-sanitized' : '';
    download(blob, `dx-snapshot${suffix}-${timestamp()}.json`);
  }, []);
}

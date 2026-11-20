import type { TopologyData } from '../types/topology';

/** Cloud WAN data read from one spoke account with its assumed role. */
export interface SpokeCloudWan {
  coreNetworks: TopologyData['cloudWanCoreNetworks'];
  attachments: TopologyData['cloudWanAttachments'];
  peerings: TopologyData['cloudWanPeerings'];
  routes: TopologyData['cloudWanRoutes'];
}

export interface CloudWanMergeCounts {
  coreNetworks: number;
  attachments: number;
  peerings: number;
}

/**
 * Merge a spoke account's Cloud WAN data into the topology, in place.
 *
 * A core network belongs to one account (Network Manager has no cross-account
 * read), so when the Direct Connect gateways live in one account and Cloud WAN
 * in another, the signed-in account sees only its half: DXGW associations that
 * name a core network it cannot fetch, and so no DXGW → Core Network edge. The
 * owning account, added as a spoke, supplies the other half.
 *
 * Deduplicated by id, first writer wins — the signed-in account's own fetch
 * runs first, so a spoke never overwrites what it already holds. The overlap is
 * real, not hypothetical: an account lists its OWN attachments to a core
 * network it does not own (a DXGW owner sees its DXGW attachments), and the
 * core network's owner lists those same attachments again.
 *
 * One exception: a `summaryOnly` core network (received through RAM, so the
 * signed-in account could list it but not describe it) is REPLACED by a full
 * copy from the owner, and takes the owner's routes with it. Keeping the
 * summary would draw the core network with no edges or segments even though
 * the owner just supplied them. A full copy is never replaced, and a spoke's
 * own summary-only copy never replaces anything.
 */
export function mergeSpokeCloudWan(topology: TopologyData, spoke: SpokeCloudWan): CloudWanMergeCounts {
  const counts: CloudWanMergeCounts = { coreNetworks: 0, attachments: 0, peerings: 0 };

  const cnIndex = new Map(topology.cloudWanCoreNetworks.map((c, i) => [c.coreNetworkId, i]));
  const upgraded = new Set<string>();
  for (const cn of spoke.coreNetworks) {
    const i = cnIndex.get(cn.coreNetworkId);
    if (i === undefined) {
      cnIndex.set(cn.coreNetworkId, topology.cloudWanCoreNetworks.length);
      topology.cloudWanCoreNetworks.push(cn);
      counts.coreNetworks++;
    } else if (topology.cloudWanCoreNetworks[i].summaryOnly && !cn.summaryOnly) {
      topology.cloudWanCoreNetworks[i] = cn;
      upgraded.add(cn.coreNetworkId);
      counts.coreNetworks++;
    }
  }

  const attIds = new Set(topology.cloudWanAttachments.map((a) => a.attachmentId));
  for (const att of spoke.attachments) {
    if (attIds.has(att.attachmentId)) continue;
    topology.cloudWanAttachments.push(att);
    attIds.add(att.attachmentId);
    counts.attachments++;
  }

  const peeringIds = new Set(topology.cloudWanPeerings.map((p) => p.peeringId));
  for (const p of spoke.peerings) {
    if (peeringIds.has(p.peeringId)) continue;
    topology.cloudWanPeerings.push(p);
    peeringIds.add(p.peeringId);
    counts.peerings++;
  }

  for (const [cnId, routes] of spoke.routes) {
    if (!topology.cloudWanRoutes.has(cnId) || upgraded.has(cnId)) topology.cloudWanRoutes.set(cnId, routes);
  }

  return counts;
}

import { describe, it, expect } from 'vitest';
import {
  planUserEdge,
  isUserDrawnPair,
  normalizeUserEdges,
  customerLinkId,
  type ConnectEndpoint,
} from '../user-edges';

const router = (id: string, y: number): ConnectEndpoint => ({ id, category: 'onPremise', y });
// `dxPartnerDevice` is the card the UI labels "Customer Gateway" — the customer's
// own device in the DX location.
const partner = (id: string, y = 0): ConnectEndpoint => ({ id, category: 'dxPartnerDevice', y });

describe('planUserEdge — cross-connect (router → partner device)', () => {
  it('keeps the handles the user grabbed', () => {
    const planned = planUserEdge(router('onprem-EqDC2', 100), partner('partner-dxcon-a'), {
      sourceHandle: 'left-source',
      targetHandle: null,
    });
    expect(planned).not.toBeNull();
    expect(planned!.kind).toBe('crossConnect');
    expect(planned!.edge).toMatchObject({
      id: 'user-onprem-EqDC2-partner-dxcon-a',
      source: 'onprem-EqDC2',
      target: 'partner-dxcon-a',
      sourceHandle: 'left-source',
      targetHandle: undefined,
      type: 'customEdge',
    });
  });

  it('is not a peering edge, so it keeps full end-to-end hover', () => {
    const planned = planUserEdge(router('onprem-EqDC2', 0), partner('partner-dxcon-a'));
    expect(planned!.edge.data?.isPeering).toBeUndefined();
  });
});

describe('planUserEdge — customer link (router ↔ router)', () => {
  it('connects two on-prem routers', () => {
    const planned = planUserEdge(router('onprem-EqDC2', 100), router('onprem-EqSE2', 400));
    expect(planned).not.toBeNull();
    expect(planned!.kind).toBe('customerLink');
    expect(planned!.edge.type).toBe('customEdge');
  });

  it('anchors the upper router as the source and routes bottom → top', () => {
    const planned = planUserEdge(router('onprem-EqDC2', 100), router('onprem-EqSE2', 400));
    expect(planned!.edge).toMatchObject({
      source: 'onprem-EqDC2',
      target: 'onprem-EqSE2',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
  });

  it('re-orients when the user drags upward, so the line still drops down', () => {
    // Dragged from the LOWER router to the upper one.
    const planned = planUserEdge(router('onprem-EqSE2', 400), router('onprem-EqDC2', 100));
    expect(planned!.edge).toMatchObject({
      source: 'onprem-EqDC2',
      target: 'onprem-EqSE2',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
  });

  it('overrides whichever handles the user grabbed', () => {
    const planned = planUserEdge(router('a', 0), router('b', 50), {
      sourceHandle: 'left-source',
      targetHandle: 'top',
    });
    expect(planned!.edge.sourceHandle).toBe('bottom');
    expect(planned!.edge.targetHandle).toBe('top');
  });

  it('breaks an exact y tie on id so the direction is stable either way round', () => {
    const forward = planUserEdge(router('onprem-aaa', 200), router('onprem-bbb', 200));
    const reverse = planUserEdge(router('onprem-bbb', 200), router('onprem-aaa', 200));
    expect(forward!.edge.source).toBe('onprem-aaa');
    expect(reverse!.edge.source).toBe('onprem-aaa');
  });

  it('is a peering edge, so hovering highlights the pair not both full paths', () => {
    const planned = planUserEdge(router('a', 0), router('b', 50));
    expect(planned!.edge.data?.isPeering).toBe(true);
  });

  it('carries no label, matching the unlabelled cross-connect', () => {
    const planned = planUserEdge(router('a', 0), router('b', 50));
    expect(planned!.edge.data?.label).toBeUndefined();
  });

  it('is lateral, so the path traversal cannot inherit its cosmetic direction', () => {
    const planned = planUserEdge(router('a', 0), router('b', 50));
    expect(planned!.edge.data?.isLateral).toBe(true);
  });

  it('gives the same id whichever way it is drawn, so a redraw de-duplicates', () => {
    const forward = planUserEdge(router('onprem-EqDC2', 100), router('onprem-EqSE2', 400));
    const reverse = planUserEdge(router('onprem-EqSE2', 400), router('onprem-EqDC2', 100));
    expect(forward!.edge.id).toBe(reverse!.edge.id);
    expect(forward!.edge.id).toBe(customerLinkId('onprem-EqSE2', 'onprem-EqDC2'));
  });

  it('does not collide with a cross-connect id', () => {
    const link = planUserEdge(router('onprem-a', 0), router('onprem-b', 50))!;
    const cross = planUserEdge(router('onprem-a', 0), partner('onprem-b'))!;
    expect(link.edge.id).not.toBe(cross.edge.id);
  });

  it('links two routers inside the same site as readily as two sites', () => {
    // Same customer site: an HA pair, ids sharing the site suffix.
    const planned = planUserEdge(router('onprem-EqDC2', 100), router('user-onprem-EqDC2-1', 200));
    expect(planned!.kind).toBe('customerLink');
  });
});

describe('planUserEdge — customer link (Customer Gateway ↔ Customer Gateway)', () => {
  it('links two DX-location customer devices', () => {
    const planned = planUserEdge(partner('partner-dxcon-a', 100), partner('partner-dxcon-b', 300));
    expect(planned).not.toBeNull();
    expect(planned!.kind).toBe('customerLink');
  });

  it('anchors and labels them exactly like a router pair', () => {
    const planned = planUserEdge(partner('partner-dxcon-b', 300), partner('partner-dxcon-a', 100));
    expect(planned!.edge).toMatchObject({
      id: customerLinkId('partner-dxcon-a', 'partner-dxcon-b'),
      source: 'partner-dxcon-a',
      target: 'partner-dxcon-b',
      sourceHandle: 'bottom',
      targetHandle: 'top',
      data: { isPeering: true, isLateral: true },
    });
  });

  it('does not link a device to a router — that pair is the cross-connect', () => {
    const planned = planUserEdge(router('onprem-EqDC2', 0), partner('partner-dxcon-a', 200));
    expect(planned!.kind).toBe('crossConnect');
  });

  it('leaves the collapsed group card alone', () => {
    const group = (id: string, y: number): ConnectEndpoint => ({ id, category: 'dxPartnerDeviceGroup', y });
    expect(planUserEdge(group('g1', 0), group('g2', 100))).toBeNull();
    expect(planUserEdge(partner('partner-dxcon-a', 0), group('g2', 100))).toBeNull();
  });
});

describe('normalizeUserEdges', () => {
  it('adds the flags back to a link persisted by an older build', () => {
    const stale = {
      id: customerLinkId('onprem-a', 'onprem-b'),
      source: 'onprem-a',
      target: 'onprem-b',
      sourceHandle: 'bottom',
      targetHandle: 'top',
      data: { isPeering: true },
    };
    const [fixed] = normalizeUserEdges([stale]);
    expect(fixed.data).toMatchObject({ isPeering: true, isLateral: true });
    // Endpoints and routing are untouched — only the flags are restated.
    expect(fixed).toMatchObject({ source: 'onprem-a', target: 'onprem-b', sourceHandle: 'bottom' });
  });

  it('strips the label a build that still drew one left behind', () => {
    const [fixed] = normalizeUserEdges([
      {
        id: customerLinkId('a', 'b'),
        source: 'a',
        target: 'b',
        data: { label: 'Customer Link', isPeering: true, isLateral: true },
      },
    ]);
    expect(fixed.data?.label).toBeUndefined();
  });

  it('leaves cross-connects alone — they are path steps, not lateral', () => {
    const cross = { id: 'user-onprem-a-partner-b', source: 'onprem-a', target: 'partner-b' };
    const [same] = normalizeUserEdges([cross]);
    expect(same.data?.isLateral).toBeUndefined();
    expect(same).toBe(cross);
  });

  it('is idempotent, since it runs on every hydration', () => {
    const once = normalizeUserEdges(
      [planUserEdge(router('onprem-a', 0), router('onprem-b', 50))!.edge],
    );
    expect(normalizeUserEdges(once)).toEqual(once);
  });
});

describe('isUserDrawnPair', () => {
  it('accepts exactly the pairs planUserEdge can create', () => {
    expect(isUserDrawnPair('onPremise', 'dxPartnerDevice')).toBe(true);
    expect(isUserDrawnPair('onPremise', 'onPremise')).toBe(true);
    expect(isUserDrawnPair('dxPartnerDevice', 'dxPartnerDevice')).toBe(true);
  });

  it('rejects AWS-reported edges, so they never offer a delete affordance', () => {
    expect(isUserDrawnPair('dxPartnerDevice', 'awsDevice')).toBe(false);
    expect(isUserDrawnPair('awsDevice', 'dxGateway')).toBe(false);
    expect(isUserDrawnPair('dxGateway', 'tgw')).toBe(false);
    expect(isUserDrawnPair('vpc', 'vpc')).toBe(false);
  });

  it('rejects an unknown category, since an unresolved node is not a licence to delete', () => {
    expect(isUserDrawnPair(undefined, 'onPremise')).toBe(false);
    expect(isUserDrawnPair('onPremise', undefined)).toBe(false);
  });
});

describe('planUserEdge — rejections', () => {
  it('rejects a self-loop', () => {
    expect(planUserEdge(router('onprem-EqDC2', 100), router('onprem-EqDC2', 100))).toBeNull();
  });

  it('rejects a missing endpoint', () => {
    expect(planUserEdge(undefined, router('onprem-a', 0))).toBeNull();
    expect(planUserEdge(router('onprem-a', 0), undefined)).toBeNull();
  });

  it('rejects the reverse cross-connect (partner device → router)', () => {
    expect(planUserEdge(partner('partner-dxcon-a'), router('onprem-EqDC2', 100))).toBeNull();
  });

  it('rejects every other category pair', () => {
    const cases: [string, string][] = [
      ['dxGateway', 'dxGateway'],
      ['vpc', 'vpc'],
      ['onPremise', 'dxGateway'],
      ['onPremise', 'cgw'],
      ['awsDevice', 'dxPartnerDevice'],
      ['customerSite', 'onPremise'],
    ];
    for (const [srcCat, tgtCat] of cases) {
      const planned = planUserEdge(
        { id: 'src', category: srcCat, y: 0 },
        { id: 'tgt', category: tgtCat, y: 100 },
      );
      expect(planned, `${srcCat} → ${tgtCat} must be rejected`).toBeNull();
    }
  });
});

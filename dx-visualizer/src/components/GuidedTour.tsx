import { useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { driver, type Driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useIsLight } from '../hooks/useTheme';

const STORAGE_KEY = 'ra-tour-seen-v1';

export interface GuidedTourHandle {
  start: () => void;
}

const steps: DriveStep[] = [
  {
    popover: {
      title: 'Welcome to the Resilience Agent',
      description:
        'A quick tour of what each part of the UI does. You can skip anytime and restart it from the ⋯ menu in the top bar.',
    },
  },
  {
    element: '[data-tour="topology"]',
    popover: {
      title: 'Topology canvas',
      description:
        'Your AWS Direct Connect network, laid out in columns from on-prem (left) to VPCs (right). Zoom with the controls on the top-left and toggle the legend on the top-right. Hover an edge to highlight its full path. An "Unattached resources" container at the bottom surfaces DXGWs, VGWs, VPCs, and TGWs that exist in the account but aren\'t wired into any DX path.',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="lock"]',
    popover: {
      title: 'Lock / unlock the canvas',
      description:
        'Unlock (green) to drag nodes and rearrange the layout. Lock (red) freezes positions so accidental drags don\'t shift anything — handy while reading the topology or demoing. In lock mode, labels, IDs, CIDRs, and ASNs inside nodes are selectable — click and drag over any value to copy it.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="topology"]',
    popover: {
      title: 'Edit your topology locally',
      description:
        'The canvas supports light edits so you can model "what if" changes without touching AWS. Click the + on a Customer Site header to add another Customer Data Center (drag, resize, or × to remove). Drag between a Customer Gateway\'s right handle and a Partner Device\'s left handle to draw a cable — the on-prem-to-partner cable is never auto-drawn since AWS can\'t see it. Hover an existing cable for an × to remove it, or select it and press Delete. Edits persist until you refresh or switch scenarios.',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="overlays"]',
    popover: {
      title: 'Canvas overlays',
      description:
        'Toggles layered onto the topology: Live Status overlays health indicators from the last fetch; Utilization shows peak ingress/egress against configured bandwidth from CloudWatch; Recommendation reveals ghost nodes (green, dashed) showing the extra connections needed to reach a higher SLA tier. The lightning-bolt icon next to the chat button toggles Simulate mode — click zones, nodes, or edges to fail them and see how many paths survive.',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '[data-tour="scorecard"]',
    popover: {
      title: 'Resilience Status',
      description:
        'Open action items for your topology — current SLA tier per DX Gateway, upgrade options, and best-practice checks. The badge shows how many items are still unmet. Expand to pick a target tier, download an HTML report, or open a full-screen view. Hovering a gateway row spotlights the matching node on the canvas.',
      side: 'right',
      align: 'end',
    },
  },
  {
    element: '[data-tour="maintenance"]',
    popover: {
      title: 'Planned maintenance',
      description:
        'A calendar of upcoming AWS-scheduled maintenance events affecting your Direct Connect resources. The badge shows how many are open. Click a day to see affected connections, VIFs, and gateways, and jump straight to the next scheduled window. Only appears when events exist.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="chat"]',
    popover: {
      title: 'Chat with your topology',
      description:
        'Ask questions in plain English — "what happens if us-east-1 goes down?", "cost of adding a second connection?". The assistant knows your full topology and current assessment, and can run tools to fetch pricing or update the canvas.',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="overflow"]',
    popover: {
      title: 'More options',
      description:
        'The ⋯ menu holds refresh, topology image export, this tour, and the light/dark theme toggle. Restart the tour anytime from here.',
      side: 'left',
      align: 'end',
    },
  },
];

/**
 * On first visit we auto-start the tour. The Help button in TopBar also
 * exposes a manual re-run via the imperative handle.
 */
export const GuidedTour = forwardRef<GuidedTourHandle>(function GuidedTour(_, ref) {
  const light = useIsLight();

  const run = useCallback(() => {
    const filteredSteps = steps.filter((step) => {
      const selector = step.element;
      if (typeof selector !== 'string') return true;
      return !!document.querySelector(selector);
    });

    const d: Driver = driver({
      showProgress: true,
      allowClose: true,
      overlayOpacity: light ? 0.45 : 0.65,
      stagePadding: 6,
      stageRadius: 10,
      popoverClass: light ? 'ra-tour-light' : 'ra-tour-dark',
      nextBtnText: 'Next →',
      prevBtnText: '← Back',
      doneBtnText: 'Done',
      progressText: '{{current}} of {{total}}',
      steps: filteredSteps,
      onDestroyed: () => {
        try {
          localStorage.setItem(STORAGE_KEY, '1');
        } catch {
          // localStorage unavailable — ignore
        }
      },
    });

    d.drive();
  }, [light]);

  useImperativeHandle(ref, () => ({ start: run }), [run]);

  useEffect(() => {
    let seen: boolean;
    try {
      seen = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // localStorage unavailable — treat as already seen so the tour stays quiet.
      seen = true;
    }
    if (seen) return;

    // Defer to the next paint so element queries resolve against a rendered DOM.
    const timer = window.setTimeout(run, 600);
    return () => window.clearTimeout(timer);
  }, [run]);

  return null;
});

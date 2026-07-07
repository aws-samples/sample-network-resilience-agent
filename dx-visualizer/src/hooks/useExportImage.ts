import { useCallback } from 'react';
import { getNodesBounds, getViewportForBounds, useReactFlow } from '@xyflow/react';
import { toPng } from 'html-to-image';
import { useTopologyStore } from '../store/topology-store';

const TARGET_WIDTH_4K = 3840;
const PADDING = 80;

// Tooltip titles of the interactive route/peer panel toggles, stripped from the
// exported image where they can't be clicked. Kept in sync with the buttons in
// VpcNode / TgwNode / CoreNetworkNode.
const HIDDEN_EXPORT_TITLES = new Set([
  'View route tables',
  'List VPC peering connections',
  'View Cloud WAN routes',
]);

function download(dataUrl: string, filename: string) {
  // Chrome ignores the anchor's `download` filename for large data: URLs (our PNGs
  // run ~1 MB) and saves them under a random hash instead. Route through a Blob +
  // object URL, which preserves the filename regardless of size. The anchor is also
  // attached to the DOM before click() for cross-browser reliability.
  const [meta, base64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(meta)?.[1] ?? 'image/png';
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));

  const link = document.createElement('a');
  link.download = filename;
  link.href = blobUrl;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after a tick so the download has grabbed the URL.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}

function timestamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function useExportImage() {
  const { getNodes, screenToFlowPosition } = useReactFlow();
  const theme = useTopologyStore((s) => s.theme);

  return useCallback(async () => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewport) return;

    const nodes = getNodes();
    if (nodes.length === 0) return;

    const bounds = getNodesBounds(nodes);

    // getNodesBounds measures node rectangles only. Edge labels (e.g. the VPC
    // peering "USE1-Hub-to-…" chips) render in a separate layer and can extend
    // past the outermost nodes, so they'd be clipped by a node-only capture box.
    // Union each rendered edge label's flow-space extent into the bounds.
    const labelWrap = document.querySelector('.react-flow__edgelabel-renderer');
    if (labelWrap) {
      let minX = bounds.x;
      let minY = bounds.y;
      let maxX = bounds.x + bounds.width;
      let maxY = bounds.y + bounds.height;
      for (const el of Array.from(labelWrap.children)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const tl = screenToFlowPosition({ x: rect.left, y: rect.top });
        const br = screenToFlowPosition({ x: rect.right, y: rect.bottom });
        minX = Math.min(minX, tl.x);
        minY = Math.min(minY, tl.y);
        maxX = Math.max(maxX, br.x);
        maxY = Math.max(maxY, br.y);
      }
      bounds.x = minX;
      bounds.y = minY;
      bounds.width = maxX - minX;
      bounds.height = maxY - minY;
    }

    const width = Math.ceil(bounds.width + PADDING * 2);
    const height = Math.ceil(bounds.height + PADDING * 2);

    const transform = getViewportForBounds(bounds, width, height, 0.5, 2, 0);

    const background = theme === 'light' ? '#eef1f6' : '#0f172a';

    const filter = (node: Element) => {
      if (!(node instanceof Element) || !node.classList) return true;
      const cls = node.classList;
      // Drop the interactive Routes / Peers toggle buttons — they do nothing in a
      // static image. Matched by their (stable) tooltip titles so only the buttons
      // are excluded from the export clone; the live canvas keeps them.
      if (HIDDEN_EXPORT_TITLES.has(node.getAttribute('title') ?? '')) return false;
      return !cls.contains('react-flow__minimap')
        && !cls.contains('react-flow__controls')
        && !cls.contains('react-flow__panel')
        && !cls.contains('react-flow__background')
        && !cls.contains('sim-canvas-frame');
    };

    const pixelRatio = Math.min(4, Math.max(2, TARGET_WIDTH_4K / width));

    // Ensure the web fonts (Plus Jakarta Sans / JetBrains Mono) are fully decoded
    // before capture. html-to-image rasterizes the node into an isolated SVG
    // <foreignObject> that can't see the page's loaded fonts, so it re-fetches
    // and inlines them; if they aren't ready (or the fetch is blocked) the PNG
    // falls back to a wider system font and node labels rewrap onto extra lines,
    // overlapping the text below them. (The font-embed fetch is permitted by the
    // fonts.googleapis.com / fonts.gstatic.com entries in the CSP connect-src.)
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    // Hide the interactive Routes/Peers toggles for the capture. This is done in
    // the LIVE DOM (display:none) rather than via html-to-image's node filter,
    // because the filter removes the button from the clone *after* the card's
    // height was already measured with the button present — leaving an empty band
    // below the content inside the card border. Hiding here forces the card to
    // reflow to its true collapsed height first, so the border wraps tightly.
    // Also let the card's fill wrapper hug that content. Scoped to [data-node-card]
    // (BaseNode leaf cards) so container nodes (regions, AWS cloud, VPC groups) are
    // untouched; items-center keeps the card centered on the node's original
    // center so edge/handle anchors don't move.
    const hideSelectors = [...HIDDEN_EXPORT_TITLES]
      .map((t) => `[title="${t}"]`)
      .join(', ');
    const exportStyle = document.createElement('style');
    exportStyle.textContent = `
      ${hideSelectors} { display: none !important; }
      .react-flow__node > [data-node-card] { height: auto !important; align-self: center; }
    `;
    document.head.appendChild(exportStyle);
    // Force a synchronous reflow so the cards collapse before html-to-image
    // snapshots their computed sizes.
    void viewport.offsetHeight;

    let dataUrl: string;
    try {
      dataUrl = await toPng(viewport, {
        backgroundColor: background,
        width,
        height,
        pixelRatio,
        filter,
        cacheBust: true,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
        },
      });
    } finally {
      exportStyle.remove();
    }

    download(dataUrl, `topology-${timestamp()}.png`);
  }, [getNodes, theme]);
}

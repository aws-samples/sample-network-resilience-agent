import { describe, it, expect } from 'vitest';
import { computeDropSnap, type ChildRect } from '../drop-snap';

describe('computeDropSnap', () => {
  const containerW = 260;
  const containerH = 200;
  const draggedW = 200;
  const draggedH = 80;

  it('places node below header when container has no children', () => {
    const result = computeDropSnap(100, containerW, containerH, draggedW, draggedH, []);

    expect(result.relY).toBe(40 + 12); // CONTAINER_PAD_TOP + SNAP_GAP
    expect(result.relX).toBe(30); // centered: (260 - 200) / 2
  });

  it('places node below existing children when dropped below midpoint', () => {
    const children: ChildRect[] = [
      { x: 20, y: 40, width: 200, height: 80 },
    ];
    // Drop at y=100 which is below midpoint of (40, 120) = 80
    const result = computeDropSnap(100, containerW, containerH, draggedW, draggedH, children);

    expect(result.relY).toBe(120 + 12); // child bottom (40+80=120) + SNAP_GAP
  });

  it('places node above existing children when dropped above midpoint', () => {
    const children: ChildRect[] = [
      { x: 20, y: 100, width: 200, height: 80 },
    ];
    // midpoint = (100 + 180) / 2 = 140, drop at 50 < 140
    const result = computeDropSnap(50, containerW, containerH, draggedW, draggedH, children);

    // highestChildTop(100) - draggedH(80) - SNAP_GAP(12) = 8, but clamped to PAD_TOP(40)
    expect(result.relY).toBe(40);
  });

  it('resizes container when new child extends beyond current bounds', () => {
    const children: ChildRect[] = [
      { x: 20, y: 40, width: 200, height: 80 },
    ];
    // Small container that won't fit a second child
    const result = computeDropSnap(200, 260, 140, draggedW, draggedH, children);

    expect(result.resized).toBe(true);
    expect(result.newContainerHeight).toBeGreaterThan(140);
  });

  it('does not resize when container is already large enough', () => {
    const children: ChildRect[] = [
      { x: 20, y: 40, width: 200, height: 80 },
    ];
    // Very large container
    const result = computeDropSnap(200, 400, 500, draggedW, draggedH, children);

    expect(result.resized).toBe(false);
    expect(result.newContainerWidth).toBe(400);
    expect(result.newContainerHeight).toBe(500);
  });

  it('centers node horizontally within container', () => {
    const result = computeDropSnap(100, 300, 300, 200, 80, []);

    expect(result.relX).toBe(50); // (300 - 200) / 2
  });

  it('uses CONTAINER_PAD_X as minimum horizontal position', () => {
    // Container barely wider than the node
    const result = computeDropSnap(100, 210, 300, 200, 80, []);

    expect(result.relX).toBe(20); // CONTAINER_PAD_X, since (210-200)/2=5 < 20
  });

  it('stacks multiple children vertically', () => {
    const children: ChildRect[] = [
      { x: 20, y: 40, width: 200, height: 80 },
      { x: 20, y: 132, width: 200, height: 80 }, // 40+80+12=132
    ];
    // Drop below midpoint
    const result = computeDropSnap(200, 260, 400, draggedW, draggedH, children);

    expect(result.relY).toBe(212 + 12); // lowestBottom(132+80=212) + SNAP_GAP
  });
});

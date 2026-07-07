export interface ChildRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapResult {
  relX: number;
  relY: number;
  newContainerWidth: number;
  newContainerHeight: number;
  resized: boolean;
}

const CONTAINER_PAD_TOP = 40;
const CONTAINER_PAD_BOTTOM = 20;
const CONTAINER_PAD_X = 20;
const SNAP_GAP = 12;

export function computeDropSnap(
  dropRelY: number,
  containerW: number,
  containerH: number,
  draggedW: number,
  draggedH: number,
  existingChildren: ChildRect[],
): SnapResult {
  const childrenBottoms = existingChildren.map((c) => c.y + c.height);
  const childrenTops = existingChildren.map((c) => c.y);
  const lowestChildBottom = childrenBottoms.length > 0 ? Math.max(...childrenBottoms) : CONTAINER_PAD_TOP;
  const highestChildTop = childrenTops.length > 0 ? Math.min(...childrenTops) : CONTAINER_PAD_TOP;
  const childrenMidpoint = (highestChildTop + lowestChildBottom) / 2;

  let relY: number;
  if (dropRelY < childrenMidpoint && existingChildren.length > 0) {
    relY = highestChildTop - draggedH - SNAP_GAP;
  } else {
    relY = lowestChildBottom + SNAP_GAP;
  }

  relY = Math.max(relY, CONTAINER_PAD_TOP);

  const relX = Math.max(CONTAINER_PAD_X, (containerW - draggedW) / 2);

  const allChildPositions = [
    ...existingChildren.map((c) => ({
      top: c.y,
      bottom: c.y + c.height,
      right: c.x + c.width,
    })),
    { top: relY, bottom: relY + draggedH, right: relX + draggedW },
  ];

  const maxChildBottom = Math.max(...allChildPositions.map((c) => c.bottom));
  const maxChildRight = Math.max(...allChildPositions.map((c) => c.right));

  const requiredH = maxChildBottom + CONTAINER_PAD_BOTTOM;
  const requiredW = maxChildRight + CONTAINER_PAD_X;

  const newW = Math.max(containerW, requiredW);
  const newH = Math.max(containerH, requiredH);

  return {
    relX,
    relY,
    newContainerWidth: newW,
    newContainerHeight: newH,
    resized: newW !== containerW || newH !== containerH,
  };
}

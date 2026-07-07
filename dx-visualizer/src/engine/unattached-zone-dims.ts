// Single source of truth for the Unattached-zone container dimensions.
// Both the layout engine (Step 9.25) and UnattachedZoneNode read from here so
// the rendered body matches the reserved container box. When UnattachedZoneNode's
// markup changes, update the constants below and both sides stay in sync.

// Measured against the rendered DOM (Playwright getBoundingClientRect, 2026-04-29):
//   header button h=40, body padY=10+10, section title h=16.5 + mb=6,
//   thead h=24, tbody row h=24. Add 2px slack per row so sub-pixel rounding
//   on zoom or different font rendering can't clip the last row.
export const ZONE_DIMS = {
  headerH: 40,            // explicit height on the header button
  bodyPadY: 20,           // px-3.5 py-2.5 → 10 + 10
  sectionLabelH: 24,      // 11px text × 1.5 line-height + mb-1.5 (6) ≈ 22.5, round up
  tableHeaderH: 25,       // thead: 24 + 1px slack
  tableRowH: 25,          // tbody: 24 + 1px slack
  tablesGap: 12,          // mb-3 between VPC and TGW sections
  marginTop: 36,          // gap between regions block bottom and zone top
  minWidth: 500,          // floor for zone width inside AWS Cloud
};

/**
 * Returns the total height of the zone container given how many rows are
 * in each table and whether the zone is expanded. Counts are passed in the
 * same order the renderer draws the sections (DXGWs → VGWs → VPCs → TGWs).
 */
export function zoneHeight(
  vpcCount: number,
  tgwCount: number,
  expanded: boolean,
  vgwCount = 0,
  dxgwCount = 0
): number {
  if (!expanded) return ZONE_DIMS.headerH;
  const sectionH = (rows: number) => ZONE_DIMS.sectionLabelH + ZONE_DIMS.tableHeaderH + rows * ZONE_DIMS.tableRowH;
  const counts = [dxgwCount, vgwCount, vpcCount, tgwCount].filter((c) => c > 0);
  let content = 0;
  counts.forEach((c, i) => {
    if (i > 0) content += ZONE_DIMS.tablesGap;
    content += sectionH(c);
  });
  return ZONE_DIMS.headerH + ZONE_DIMS.bodyPadY + content;
}

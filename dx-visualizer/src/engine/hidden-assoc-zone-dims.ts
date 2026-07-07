// Single source of truth for the Hidden Associations zone container
// dimensions. Both the layout engine and HiddenAssocZoneNode read from
// here so the rendered body matches the reserved container box. When
// HiddenAssocZoneNode's markup changes, update the constants below and
// both sides stay in sync.
//
// Values mirror the Unattached zone (header 40, row 24, table head 24)
// so visual rhythm is consistent when both panels are stacked inside
// the AWS Cloud container.
export const HIDDEN_ASSOC_ZONE_DIMS = {
  headerH: 40,
  bodyPadY: 20,
  sectionLabelH: 22,
  // Three-line italic explainer above the table — 10px text with snug
  // leading (line-height ~1.3). Measured 3 × ~13 + bottom margin = ~44.
  explainerH: 48,
  tableHeaderH: 25,
  tableRowH: 25,
  marginTop: 36,
  minWidth: 500,
};

export function hiddenAssocZoneHeight(rowCount: number, expanded: boolean): number {
  if (!expanded) return HIDDEN_ASSOC_ZONE_DIMS.headerH;
  const content =
    HIDDEN_ASSOC_ZONE_DIMS.sectionLabelH +
    HIDDEN_ASSOC_ZONE_DIMS.explainerH +
    HIDDEN_ASSOC_ZONE_DIMS.tableHeaderH +
    rowCount * HIDDEN_ASSOC_ZONE_DIMS.tableRowH;
  return HIDDEN_ASSOC_ZONE_DIMS.headerH + HIDDEN_ASSOC_ZONE_DIMS.bodyPadY + content;
}

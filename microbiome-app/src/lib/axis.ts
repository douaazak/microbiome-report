/**
 * Layout for a categorical axis with many labels.
 *
 * Two things have to be decided together and were previously decided
 * separately: how many labels to draw, and how much room they need. Rotating
 * ticks without enlarging the bottom margin clips them; enlarging the margin
 * for short labels wastes half the figure.
 */

import { thinLabels } from 'microbiome-core';

import { LABEL_PITCH } from './composition';

export interface AxisLayout {
  /** The subset of labels to draw as ticks. */
  ticks: string[];
  /** Rotation in degrees; negative tilts the text up to the right. */
  tickRotate: number;
  /** Bottom margin needed to fit the rotated labels plus the axis title. */
  marginBottom: number;
}

/** Approximate width of a character at the default tick font size. */
const CHAR_WIDTH = 6.5;
/** Room for the axis title beneath the labels. */
const TITLE_SPACE = 34;

/**
 * @param labels     every category, in axis order
 * @param plotWidth  the width available for the plot area
 * @param maxVisible how many labels to draw at most
 */
export function axisLabelLayout(
  labels: string[],
  plotWidth: number,
  maxVisible?: number,
): AxisLayout {
  /*
   * How many labels fit is a function of the width, not a constant. A fixed
   * cap hides labels there is room to draw on a wide layout and crowds them
   * on a narrow one.
   */
  const budget = maxVisible ?? Math.max(4, Math.floor(plotWidth / LABEL_PITCH));
  const ticks = thinLabels(labels, budget);

  if (ticks.length === 0) {
    return { ticks, tickRotate: 0, marginBottom: TITLE_SPACE };
  }

  const longest = ticks.reduce((max, label) => Math.max(max, label.length), 0);
  const labelWidth = longest * CHAR_WIDTH;

  // Horizontal room each tick gets before its neighbour begins.
  const slot = plotWidth / ticks.length;

  /*
   * Rotation is chosen from how much room each label has, not from a fixed
   * rule. Horizontal text needs its full width; at -45° it needs roughly
   * 70% of it; vertical text needs only the line height, so it always fits.
   * Falling back to vertical is what stops long sample IDs overlapping no
   * matter how many there are.
   */
  let tickRotate: number;
  if (labelWidth <= slot * 0.9) {
    tickRotate = 0;
  } else if (labelWidth * 0.71 <= slot * 1.6) {
    tickRotate = -45;
  } else {
    tickRotate = -90;
  }

  // Vertical extent the rotated text occupies.
  const radians = (Math.abs(tickRotate) * Math.PI) / 180;
  const extent =
    tickRotate === 0 ? 12 : Math.ceil(labelWidth * Math.sin(radians)) + 8;

  return {
    ticks,
    tickRotate,
    // Capped so a pathologically long ID cannot swallow the whole figure;
    // Plot truncates beyond this rather than shrinking the plot to nothing.
    marginBottom: Math.min(extent + TITLE_SPACE, 200),
  };
}

/**
 * Marks a resource that carries the active tag filter's tags itself, as
 * opposed to the path context the filter keeps around it. Inline, no motion,
 * and drawn in the colour of the card or label it sits on (its border /
 * header accent), so it adds no new hue to the canvas.
 */
export function TagMarker({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <svg
      role="img"
      aria-label="Matches tag filter"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline-block', flexShrink: 0, verticalAlign: 'middle' }}
    >
      <title>Matches tag filter</title>
      <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill={color} />
    </svg>
  );
}

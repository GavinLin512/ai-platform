/**
 * A share of a whole: the fill in the series hue, the track a lighter step of the same ramp.
 * Decorative: the percentage is always printed next to it, so assistive tech reads that.
 */
export function Meter({ ratio }: { ratio: number }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return (
    <div aria-hidden="true" className="h-2 w-24 overflow-hidden rounded-full bg-series-1-track">
      <div className="h-full rounded-full bg-series-1" style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/** A headline number: label, value (auto-compact), and an optional detail line. */
export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-xl bg-surface p-4 ring-1 ring-gridline">
      <p className="text-sm text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted">{detail}</p> : null}
    </div>
  );
}

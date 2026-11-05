import type { RecentReview } from "@l10n-review/db";

// Status colors are reserved for state and always come with an icon and a word:
// never color alone. The word uses text ink, not the status color.
const STATUS: Record<RecentReview["status"], { icon: string; label: string; fill: string }> = {
  completed: { icon: "✓", label: "Completed", fill: "bg-good text-white" },
  failed: { icon: "✕", label: "Failed", fill: "bg-critical text-white" },
  running: { icon: "…", label: "Running", fill: "bg-warning text-[#0b0b0b]" },
};

export function StatusBadge({ status }: { status: RecentReview["status"] }) {
  const { icon, label, fill } = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold ${fill}`}
      >
        {icon}
      </span>
      <span className="text-secondary">{label}</span>
    </span>
  );
}

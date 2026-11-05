// Every formatter names its locale and time zone. A bare toLocaleString() would use the
// server's settings during rendering and the browser's after hydration (see intl-format).

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** 1,284 · 12.9K · 4.2M: full below 10,000, compact above (stat tile convention). */
export const formatCount = (n: number) =>
  Math.abs(n) < 10_000 ? integer.format(n) : compact.format(n);
export const formatPercent = (ratio: number) => percent.format(ratio);
/** Cents for totals; four decimals when the amount is below a dollar (LLM calls are cheap). */
export const formatUsd = (amount: number) =>
  amount !== 0 && Math.abs(amount) < 1 ? usdPrecise.format(amount) : usd.format(amount);
/** "2026-11-04" → "Nov 4" (the day string is a UTC date). */
export const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));
export const formatDateTime = (date: Date) => `${dateTime.format(date)} UTC`;

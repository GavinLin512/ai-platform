import { describe, expect, it } from "vitest";
import { formatCount, formatDay, formatPercent, formatUsd } from "../src/lib/format.ts";

describe("format", () => {
  it("counts in full below 10,000 and compact above", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(12_940)).toBe("12.9K");
  });
  it("shows small LLM costs with four decimals", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(1.4237)).toBe("$1.42");
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("formats percentages and UTC days regardless of the server's locale and zone", () => {
    expect(formatPercent(0.379)).toBe("38%");
    expect(formatDay("2026-11-04")).toBe("Nov 4");
  });
});

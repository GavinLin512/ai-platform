import { describe, expect, it } from "vitest";
import { parseAddedLines } from "../src/index.ts";

describe("parseAddedLines", () => {
  it("returns new-file line numbers of added lines", () => {
    const patch = [
      "@@ -1,4 +1,5 @@",
      " import { t } from 'i18n';", // 1
      "-const a = 1;",
      "+const a = 2;", // 2
      "+const b = 3;", // 3
      " ", // 4
      " export {};", // 5
    ].join("\n");

    expect([...parseAddedLines(patch)]).toEqual([2, 3]);
  });

  it("handles multiple hunks and hunks without a length", () => {
    const patch = [
      "@@ -2 +2 @@",
      "-old",
      "+new", // 2
      "@@ -20,3 +21,4 @@ export function Cart() {",
      "   return (", // 21
      "+    <p>Add to cart</p>", // 22
      "     <Total />", // 23
      "   );", // 24
    ].join("\n");

    expect([...parseAddedLines(patch)]).toEqual([2, 22]);
  });

  it("ignores the 'No newline at end of file' marker", () => {
    const patch = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    expect([...parseAddedLines(patch)]).toEqual([1]);
  });

  it("returns nothing for an empty patch", () => {
    expect(parseAddedLines("").size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { detectCandidate, diffSpans } from "../src/terminology/detect.ts";

describe("diffSpans", () => {
  it("returns merged changed spans", () => {
    expect(diffSpans("軟件更新", "軟體更新")).toEqual([{ from: "件", to: "體" }]);
    expect(diffSpans("我們的服務器正在維護", "我們的伺服器正在維護")).toEqual([
      { from: "服務", to: "伺服" },
    ]);
    expect(diffSpans("相同", "相同")).toEqual([]);
  });
});

describe("detectCandidate", () => {
  it.each([
    ["軟件更新", "件"],
    ["我們的服務器正在維護", "服務"],
    ["默認設置", "默認"],
    ["数据加载中", "数"],
  ])("flags %s", (text, changed) => {
    expect(
      detectCandidate(text)
        ?.changes.map((c) => c.from)
        .join(""),
    ).toContain(changed);
  });

  it("adds e-commerce terms OpenCC misses", () => {
    expect(detectCandidate("立即結算")?.changes).toEqual([{ from: "結算", to: "結帳" }]);
    expect(detectCandidate("全館包郵")?.changes).toEqual([{ from: "包郵", to: "免運" }]);
  });

  it.each(["請下載最新版本的軟體", "購物車", "台灣", "臺灣", "滑鼠右鍵", "加入購物車"])(
    "leaves correct Taiwan text alone: %s",
    (text) => expect(detectCandidate(text)).toBeUndefined(),
  );

  it("still proposes context-dependent words: the model, not the dictionary, decides", () => {
    // 支持 meaning "endorse" is correct in Taiwan; the dictionary cannot tell.
    expect(detectCandidate("感謝您的支持")).toBeDefined();
  });
});

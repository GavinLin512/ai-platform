import * as OpenCC from "opencc-js";

// Step 1 of the terminology check, and free: find strings that *might* use mainland wording.
//
// OpenCC round trip: Taiwan Traditional → Simplified → Taiwan Traditional with Taiwan phrases.
// If the text comes back different, it contains simplified characters or a word OpenCC's
// dictionary maps to a Taiwan equivalent (軟件 → 軟體, 服務器 → 伺服器, 視頻 → 影片).
//
// It is only a candidate generator. Measured on real strings it is both noisy and incomplete:
//  - context-blind: 「感謝您的支持」 is correct Taiwan usage, OpenCC still suggests 支援
//  - wrong suggestions: 用戶名稱 → 使用者名稱稱
//  - misses common e-commerce terms (結算, 包郵, 賬號 …), hence SUPPLEMENT below
// The LLM decides in context (rule.ts); this only decides what is worth asking about.

let converters:
  | { toSimplified: (s: string) => string; toTaiwan: (s: string) => string }
  | undefined;

function loadConverters() {
  // The dictionaries are a few MB: load them once, on first use.
  converters ??= {
    toSimplified: OpenCC.Converter({ from: "tw", to: "cn" }),
    toTaiwan: OpenCC.Converter({ from: "cn", to: "twp" }),
  };
  return converters;
}

/** Mainland terms OpenCC's dictionary does not catch, mostly e-commerce. */
export const SUPPLEMENT: Readonly<Record<string, string>> = {
  賬號: "帳號",
  賬戶: "帳戶",
  結算: "結帳",
  包郵: "免運",
  秒殺: "限時搶購",
  爆款: "熱銷",
  發貨: "出貨",
  收貨: "收件",
  快遞: "宅配",
  二維碼: "QR Code",
  質量: "品質",
  退出登錄: "登出",
  打印: "列印",
};

/** Both spellings are standard in Taiwan; a difference in these alone is not a finding. */
const EQUIVALENT_VARIANTS: [string, string][] = [["臺", "台"]];

const normalizeVariants = (text: string) =>
  EQUIVALENT_VARIANTS.reduce((s, [a, b]) => s.replaceAll(a, b), text);

export interface Candidate {
  /** OpenCC's rewrite of the whole string: a hint for the model, not an answer. */
  rewrite: string;
  /** The changed spans, e.g. { from: "軟件", to: "軟體" }. */
  changes: { from: string; to: string }[];
}

export function detectCandidate(text: string): Candidate | undefined {
  const { toSimplified, toTaiwan } = loadConverters();
  const rewrite = toTaiwan(toSimplified(text));
  const changes =
    normalizeVariants(rewrite) === normalizeVariants(text) ? [] : diffSpans(text, rewrite);

  for (const [mainland, taiwan] of Object.entries(SUPPLEMENT)) {
    if (text.includes(mainland) && !changes.some((c) => c.from.includes(mainland))) {
      changes.push({ from: mainland, to: taiwan });
    }
  }
  return changes.length > 0 ? { rewrite, changes } : undefined;
}

/**
 * The spans where `a` and `b` differ, by a longest-common-subsequence over code points.
 * Spans separated by a single unchanged character are merged, because Chinese words are
 * mostly two or three characters: 服務器 vs 伺服器 gives 服務 → 伺服, not two fragments.
 */
export function diffSpans(a: string, b: string): { from: string; to: string }[] {
  const x = [...a];
  const y = [...b];
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  );
  const at = (i: number, j: number) => (lcs[i] as number[])[j] as number;
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  // Walk the table into a list of operations: same / delete (from a) / insert (from b).
  const ops: { kind: "same" | "del" | "ins"; char: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push({ kind: "same", char: x[i++] as string });
      j++;
    } else if (j >= y.length || (i < x.length && at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ kind: "del", char: x[i++] as string });
    } else {
      ops.push({ kind: "ins", char: y[j++] as string });
    }
  }

  const spans: { from: string; to: string }[] = [];
  let current: { from: string; to: string } | undefined;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k] as (typeof ops)[number];
    if (op.kind === "same") {
      const next = ops[k + 1];
      const bridges = current && next && next.kind !== "same"; // a lone unchanged char
      if (bridges && current) {
        current.from += op.char;
        current.to += op.char;
      } else if (current) {
        spans.push(current);
        current = undefined;
      }
      continue;
    }
    current ??= { from: "", to: "" };
    if (op.kind === "del") current.from += op.char;
    else current.to += op.char;
  }
  if (current) spans.push(current);
  return spans;
}

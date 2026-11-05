import { describe, expect, it } from "vitest";
import {
  type ChangedFile,
  type ContentParityOptions,
  createContentParityRule,
  createRules,
  memoryReader,
  outlineMarkdown,
  parseConfig,
  runRules,
} from "../src/index.ts";

const options: ContentParityOptions = {
  sourceLocale: "zh-TW",
  pairs: [{ source: "content/blog", translations: { en: "content/en/blog" } }],
};
const ZH = "content/blog/post.md";
const EN = "content/en/blog/post.md";

/** A post in the shape the portfolio uses: front matter, sections, a list, code, a link. */
function post(lang: "zh" | "en", changes: Partial<Record<string, string>> = {}) {
  const zh = lang === "zh";
  const parts = {
    frontMatter: zh
      ? "title: 你的 AI 助手會讀 AGENTS.md\ndate: 2026-11-04\ntags: [security, ai]"
      : "title: Your AI Assistant Will Read AGENTS.md\ndate: 2026-11-04\ntags: [security, ai]",
    intro: zh
      ? "我現在寫程式大量依賴 coding agent，請看 [官方文件](https://example.com/docs)。"
      : "These days I lean heavily on coding agents; see [the docs](https://example.com/docs).",
    list: zh
      ? "- **LiteLLM**：你信任了一個套件\n- **CI 加固**：你信任了一個 tag\n- **AGENTS.md**：你信任了一個檔案"
      : "- **LiteLLM**: you trusted a package\n- **CI hardening**: you trusted a tag\n- **AGENTS.md**: you trusted a file",
    code: zh
      ? '```dockerfile\n# 以 digest 鎖定 base image\nFROM php:8.4.27-fpm\nRUN echo "[OK] 已修補"\n```'
      : '```dockerfile\n# Pin the base image by digest\nFROM php:8.4.27-fpm\nRUN echo "[OK] patched"\n```',
    ...changes,
  };
  return [
    "---",
    parts.frontMatter,
    "---",
    "",
    zh ? "## 一個 Markdown 檔" : "## One Markdown file",
    "",
    parts.intro,
    "",
    zh ? "## 結語" : "## Wrapping up",
    "",
    parts.list,
    "",
    parts.code,
    "",
  ].join("\n");
}

/**
 * Runs the rule with `repo` as the repository. `changed` lists the files in the change and,
 * for each, the text of the lines it added ("all": the whole file is new).
 */
async function review(
  repo: Record<string, string>,
  changed: Record<string, string[] | "all">,
  ruleOptions: ContentParityOptions = options,
) {
  const files: ChangedFile[] = Object.entries(changed).map(([path, added]) => {
    const content = repo[path] as string;
    if (added === "all") return { path, content };
    const lines = content.split("\n");
    const addedLines = new Set(added.map((text) => lines.findIndex((l) => l.includes(text)) + 1));
    return { path, content, addedLines };
  });
  const findings = await runRules(files, {
    rules: [createContentParityRule(ruleOptions)],
    reader: memoryReader(repo),
  });
  return findings.map(({ path, line, severity, message }) => ({ path, line, severity, message }));
}

describe("content-parity", () => {
  it("accepts a faithful translation: prose, title, code comments and output text differ", async () => {
    const repo = { [ZH]: post("zh"), [EN]: post("en") };
    expect(await review(repo, { [ZH]: "all", [EN]: "all" })).toEqual([]);
  });

  it("finds the list that was left behind: the case from the portfolio's AGENTS.md post", async () => {
    const five =
      "- **PHP2Shell**：你信任了 `composer update`\n- **Agent Skills**：你信任了一個 skill\n- **LiteLLM**：你信任了一個套件\n- **CI 加固**：你信任了一個 tag\n- **AGENTS.md**：你信任了一個檔案";
    const repo = { [ZH]: post("zh", { list: five }), [EN]: post("en") };

    // The change added two items to the Chinese list and did not touch the English post:
    // reported on the Chinese list, the only place the change can be commented on.
    const zhOnly = await review(repo, { [ZH]: ["PHP2Shell", "Agent Skills"] });
    expect(zhOnly).toEqual([
      {
        path: ZH,
        line: 13,
        severity: "warning",
        message:
          "This list has 5 items, but the matching list in the en version (line 13) has 3. Was an item added or removed in only one version?",
      },
    ]);

    // When the change touches both versions, the translation gets it: it is the one behind.
    const both = await review(repo, { [ZH]: "all", [EN]: "all" });
    expect(both).toMatchObject([
      { path: EN, line: 13, message: expect.stringContaining("has 3 items") },
    ]);
  });

  it("reports where the change added the line, even if it also edited the other version", async () => {
    // From the portfolio's history: one commit added items to the Chinese list and also
    // edited the English post, but not its list. The finding must stay on the Chinese list.
    const five = "- 一\n- 二\n- 三\n- 四\n- 五";
    const repo = { [ZH]: post("zh", { list: five }), [EN]: post("en") };
    const findings = await review(repo, { [ZH]: ["- 四", "- 五"], [EN]: ["These days"] });
    expect(findings).toMatchObject([
      // On the first new item, where the change can be commented on.
      { path: ZH, line: 16, message: expect.stringContaining("has 5 items") },
    ]);
  });

  it("does not blame a change for drift it did not touch", async () => {
    const repo = { [ZH]: post("zh", { list: "- 一\n- 二\n- 三\n- 四" }), [EN]: post("en") };
    expect(await review(repo, { [ZH]: ["我現在寫程式"] })).toEqual([]);
  });

  it("flags code that changed in one version only, but not translated comments", async () => {
    const code =
      '```dockerfile\n# 以 digest 鎖定 base image\nFROM php:8.4.28-fpm\nRUN echo "[OK] 已修補"\n```';
    const repo = { [ZH]: post("zh", { code }), [EN]: post("en") };
    expect(await review(repo, { [ZH]: ["8.4.28"] })).toEqual([
      {
        path: ZH,
        line: 19,
        severity: "warning",
        message:
          "This line of code differs from the en version (line 19): `FROM php:8.4.28-fpm` vs `FROM php:8.4.27-fpm`. Neither has Chinese (Taiwan) text, so it is code, not a translation: was it changed in only one version?",
      },
    ]);
  });

  it("checks code blocks: count, language and number of lines", async () => {
    const extra = `${post("zh").trimEnd()}\n\n\`\`\`bash\npnpm audit\n\`\`\`\n`;
    expect(
      await review({ [ZH]: extra, [EN]: post("en") }, { [ZH]: ["pnpm audit", "```bash"] }),
    ).toMatchObject([
      {
        path: ZH,
        message: expect.stringContaining(
          "This code block is new in this change, and the en version has no matching one (this version has 2 code blocks, the en version 1).",
        ),
      },
    ]);

    const longer =
      '```dockerfile\n# 以 digest 鎖定 base image\nFROM php:8.4.27-fpm\nRUN echo "[OK] 已修補"\nUSER www-data\n```';
    expect(
      await review(
        { [ZH]: post("zh", { code: longer }), [EN]: post("en") },
        { [ZH]: ["```dockerfile"] },
      ),
    ).toMatchObject([
      {
        message: expect.stringContaining(
          "has 4 lines, but the matching block in the en version (line 17) has 3",
        ),
      },
    ]);
  });

  it("requires untranslated front matter fields to match", async () => {
    const repo = {
      [ZH]: post("zh"),
      [EN]: post("en", {
        frontMatter: "title: A different title is fine\ndate: 2026-11-05\ntags: [security, ai]",
      }),
    };
    expect(await review(repo, { [EN]: ["date:"] })).toEqual([
      {
        path: EN,
        line: 3,
        severity: "warning",
        message:
          '"date" is "2026-11-05" here but "2026-11-04" in the zh-TW version (line 3). Only title, subtitle, description are translated; the other fields should be the same in every version.',
      },
    ]);
  });

  it("comments on the new line of a multi-line front matter value", async () => {
    const tags = (extra: string) =>
      `title: t\ndate: 2026-11-04\ntags:\n  - security\n  - ai${extra}`;
    const repo = {
      [ZH]: post("zh", { frontMatter: tags("\n  - docker") }),
      [EN]: post("en", { frontMatter: tags("") }),
    };
    expect(await review(repo, { [ZH]: ["- docker"] })).toMatchObject([
      {
        path: ZH,
        line: 7,
        message: expect.stringContaining('"tags" is ["security","ai","docker"]'),
      },
    ]);
  });

  it("without line information, points at the first section that stops matching", async () => {
    const added = post("zh").replace("## 結語", "### 細節\n\n## 結語");
    expect(await review({ [ZH]: added, [EN]: post("en") }, { [ZH]: "all", [EN]: "all" })).toEqual([
      {
        path: EN,
        line: 11,
        severity: "warning",
        message:
          "The headings stop matching the zh-TW version at this one (this version has 2 headings, the zh-TW version 3). Was one added or removed in only one version?",
      },
    ]);
  });

  it("finds a section that exists in one version only", async () => {
    const added = post("zh").replace("## 結語", "## 檢查清單\n\n- [ ] 輪替 token\n\n## 結語");
    const findings = await review({ [ZH]: added, [EN]: post("en") }, { [ZH]: ["## 檢查清單"] });
    expect(findings).toMatchObject([
      {
        path: ZH,
        line: 11,
        message:
          "This heading is new in this change, and the en version has no matching one (this version has 3 headings, the en version 2). Was it left out of the other version?",
      },
    ]);
  });

  it("compares link targets in any order, ignoring in-page anchors", async () => {
    const repo = {
      [ZH]: post("zh", {
        intro: "請看 [官方文件](https://example.com/docs) 與 [上一節](#一個-markdown-檔)。",
      }),
      [EN]: post("en", {
        intro: "See [the advisory](https://example.com/advisory) and [above](#one-markdown-file).",
      }),
    };
    expect(await review(repo, { [ZH]: "all", [EN]: "all" })).toEqual(
      [
        {
          path: EN,
          line: 9,
          severity: "info",
          message: "This links to https://example.com/advisory, but the zh-TW version does not.",
        },
        // Only in the source, which the change also touched: reported there.
        {
          path: ZH,
          line: 9,
          severity: "info",
          message: "This links to https://example.com/docs, but the en version does not.",
        },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it("notes a new original without a translation, and a translation without an original", async () => {
    expect(await review({ [ZH]: post("zh") }, { [ZH]: "all" })).toEqual([
      {
        path: ZH,
        line: 1,
        severity: "info",
        message: `There is no en version of this file yet (${EN}).`,
      },
    ]);
    expect(await review({ [EN]: post("en") }, { [EN]: "all" })).toMatchObject([
      {
        path: EN,
        line: 1,
        severity: "warning",
        message: expect.stringContaining(`version of ${ZH}, which does not exist`),
      },
    ]);
  });

  it("checks only the shape of code between two Latin-script languages", async () => {
    const latin: ContentParityOptions = {
      sourceLocale: "en",
      pairs: [{ source: "docs", translations: { fr: "docs/fr" } }],
    };
    const doc = (comment: string) =>
      `# Install\n\n\`\`\`bash\n# ${comment}\npnpm install\n\`\`\`\n`;
    const repo = {
      "docs/install.md": doc("install the dependencies"),
      "docs/fr/install.md": doc("installer les dépendances"),
    };
    // docs/fr/ is inside docs/: the longer directory wins, so the French file is a translation.
    expect(
      await review(repo, { "docs/install.md": "all", "docs/fr/install.md": "all" }, latin),
    ).toEqual([]);
  });

  it("is off unless .l10nrc.yml says where the versions live", () => {
    const ids = (text: string) =>
      createRules(parseConfig(".l10nrc.yml", text).config).map((r) => r.id);
    expect(ids("sourceLocale: zh-TW\n")).not.toContain("content-parity");
    const configured =
      "rules:\n  content-parity:\n    pairs:\n      - source: content/blog\n        translations: { en: content/en/blog }\n";
    expect(ids(configured)).toContain("content-parity");
    const typo = parseConfig(".l10nrc.yml", "rules:\n  content-parity:\n    pair: []\n");
    expect(typo.problems.map((p) => p.message)).toContain(
      'Unknown setting "rules.content-parity.pair".',
    );
  });
});

describe("outlineMarkdown", () => {
  it("reports positions in the original file, front matter included", () => {
    const outline = outlineMarkdown(post("zh"));
    expect(outline.frontMatter?.get("date")).toMatchObject({ value: "2026-11-04", line: 3 });
    expect(outline.headings.map((h) => [h.line, h.depth, h.text])).toEqual([
      [7, 2, "一個 Markdown 檔"],
      [11, 2, "結語"],
    ]);
    expect(outline.lists).toMatchObject([{ line: 13, items: 3 }]);
    expect(outline.codeBlocks).toMatchObject([{ line: 17, firstLine: 18, lang: "dockerfile" }]);
    expect(outline.links).toMatchObject([{ line: 9, url: "https://example.com/docs" }]);
  });

  it("does not compare front matter that is not valid YAML", () => {
    expect(outlineMarkdown("---\ntitle: [unclosed\n---\n\n# Hi\n").frontMatter).toBeUndefined();
  });
});

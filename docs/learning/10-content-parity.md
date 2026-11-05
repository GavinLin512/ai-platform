# 中英文章一致性檢查（content-parity）

你的 portfolio 有 5 篇中文技術文章，每篇都有英文版。`decisions.md` 裡寫著「英文版與中文版的章節、程式碼區塊數量一一對應」，目前是靠人工維持。這一輪把它變成一條規則：改了其中一個版本、另一個沒跟上，PR 上就會被標出來。

程式碼在 `packages/core/src/content/markdown.ts`（把 Markdown 拆成結構）和 `packages/core/src/rules/content-parity.ts`（比對兩個版本）。

## 這一輪完成了什麼

- 新規則 `content-parity`，檢查同一篇文章的兩個語言版本：
  - front matter：`title`、`subtitle`、`description` 以外的欄位（`date`、`tags`、`pinned`…）要相同
  - 標題的數量和層級要相同
  - 每個清單的項目數量要相同
  - 程式碼區塊的數量、語言、行數要相同；**沒有中文的那一行，兩邊要完全相同**
  - 連結的網址要相同（順序可以不同）
  - 只有原文沒有翻譯、或只有翻譯沒有原文
- 在 `.l10nrc.yml` 設定原文和翻譯各放在哪個資料夾，預設不開啟
- 測試：205 → 221 個

## 實際驗證了什麼

- 在你的 5 對文章上跑：**只有 1 個發現，而且是真的 bug**，沒有任何誤報（見概念 1）
- 重播當初造成這個 bug 的 commit（`4d749d0`），規則在那次改動就會抓到，連同另外兩個也是真的問題（見概念 4）
- 突變測試：把 4 個關鍵邏輯分別改壞，每一個都有測試失敗（見概念 5）

---

## 概念 1：讓真實資料決定規則

寫規則之前，我先用 Markdown parser 把你的 5 對文章拆開，看兩個版本**實際上**有哪些東西一樣：

| 比對的東西 | 結果 | 決定 |
|---|---|---|
| front matter | `date`、`tags`、`pinned` 全部相同，只有 `title`、`description` 不同 | 預設只有 `title`、`subtitle`、`description` 可以不同 |
| 標題 | 數量和層級全部相同 | 檢查 |
| 程式碼區塊 | 數量相同，但**大約一半的內容不同** | 不能要求完全相同 |
| 清單 | 51 個清單，只有 1 個項目數量不同 | 檢查，那 1 個要看一下 |
| 連結 | 網址集合全部相同，但有一篇數量不同 | 比對集合，不比數量和順序 |

程式碼區塊不同的地方，全部是**註解和程式輸出的文字**被翻譯了：

```bash
# 中文版
#   [FAIL] PHP 8.4.26 未修補，請升級到 8.4.27 以上
# 英文版
#   [FAIL] PHP 8.4.26 is not patched, upgrade to 8.4.27 or later
```

如果規則要求「程式碼要完全一樣」，你的每一篇文章都會被標一堆假問題，很快就會被關掉。

於是我想了另一個判斷方式：**有翻譯的行一定含中文；沒有中文、兩邊卻不同的行，就是程式碼被改了。** 拿資料驗證：

- 934 行程式碼，118 行有翻譯，全部含中文
- 沒有中文、兩邊卻不同的行：**0 行**

而清單那 1 個不一致，是真的 bug：AGENTS.md 那篇的結語，中文版寫「五篇其實在講同一件事」並列了 5 項，英文版還是「all three posts」、只有 3 項。看起來是後來補上第 1、2 篇的英文版時，第 5 篇英文版的結語沒有跟著更新。

**先用資料驗證，再寫規則。** 憑感覺寫的規則，誤報會多到沒人想用。

## 概念 2：用 AST，不要用正規表示式

Markdown 看起來簡單，但規則很多：程式碼區塊裡的 `#` 不是標題、清單可以巢狀、縮排四格也是程式碼區塊、反引號可以用 4 個……你在 `decisions.md` 記錄過的「中文粗體遇到全形標點不會生效」，就是 CommonMark 規則的細節。

所以這裡用 `mdast-util-from-markdown`，它是 Nuxt Content 底層 remark 用的 parser，會把 Markdown 轉成語法樹（AST），每個節點都帶行號：

```
root
├── heading (depth 2, line 7)
├── paragraph
├── list (line 13)
│   ├── listItem
│   └── listItem
└── code (lang: "dockerfile", line 17)
```

跟前面幾輪用 ts-morph 解析 TSX、用 ICU parser 解析翻譯字串是同一個道理：**解析交給專門的 parser，規則只處理語法樹。**

### 保留行號的小技巧

front matter（`---` 之間的 YAML）不是 Markdown，要先拿掉再交給 parser。但直接切掉的話，parser 回報的行號就會少了 front matter 那幾行。

做法是把 front matter 的內容換成空行，**換行字元保留下來**：

```ts
const body = match[0].replace(/[^\n]/g, "") + text.slice(match[0].length);
```

這樣 parser 回報的每個行號，直接就是原始檔案的行號，不用再加位移量。

## 概念 3：發現要標在哪一行

GitHub 只能在 PR **改到的行**上留言。這條規則比對的是兩個檔案，同一個問題可以標在中文版，也可以標在英文版，要選對：

1. 優先標在**翻譯**：它通常是落後的那一個
2. 但那一行必須是這次改動新增的，否則就標在原文
3. 清單、程式碼區塊這種跨好幾行的東西，標在範圍內「這次新增的第一行」

例如你在中文清單最後加了兩項，發現就會標在新加的第一項上，而不是清單沒被改到的第一行。

為什麼第 2 點很重要？見概念 4。

## 概念 4：拿 git 歷史來測試

測試只能證明「我想到的情況」沒問題。要找我沒想到的，最好的方法是**拿真實歷史重播一次**：找出當初造成 bug 的 commit，看規則在那次改動會不會抓到。

用 `git log -S` 找出「新增或刪除了某段文字」的 commit，這叫 pickaxe 搜尋：

```bash
git log --format=%h -S '**PHP2Shell**' -- content/blog/2026-11-04-agents-md-hijack-defense.md
```

找到 `4d749d0`（「journal 新增〈PHP2Shell〉並依新聞時間重新排序系列文章」），然後只檢查那一次的改動：

```bash
git checkout --detach 4d749d0
node path/to/l10n-review/packages/cli/src/cli.ts --base 4d749d0^
```

第一次重播時，**清單的問題沒有被抓到**。原因是那個 commit 中英文兩個檔案都改了，規則就決定標在英文版，但英文版改的是別的行，清單那幾行沒動，發現就被過濾掉了。

修正之後（改看「那一行有沒有被改到」，而不只是「那個檔案有沒有被改到」）再重播，那次改動有 3 個發現，全部是真的：

- PHP2Shell 那篇還沒有英文版（info）
- 中文版新增了一個連到第 2 篇的連結，英文版沒有（info）
- 結語清單中文 5 項、英文 3 項（warning）

**如果這條規則當時就在 CI 上跑，這個 bug 在那個 PR 就會被抓到。** 後來又寫了一個測試，重現同樣的情況，以後不會再壞掉。

## 概念 5：突變測試

測試都通過，不代表測試有用：也許它根本沒測到關鍵的邏輯。檢查方法是**故意把程式改壞**，看測試會不會失敗：

| 改壞的地方 | 失敗的測試數 |
|---|---|
| 把翻譯過的註解也當成程式碼 | 5 |
| 只要翻譯檔有改就標在翻譯檔（上面那個 bug） | 1 |
| 比對頁內錨點連結（`#標題`，這種會隨翻譯改變） | 1 |
| 只看元素的第一行有沒有被改 | 2 |

每一個都有測試抓到，表示測試真的在保護這些邏輯。如果改壞了測試還是全部通過，就要補測試。

這個做法有專門的工具（JavaScript 的 Stryker、PHP 的 Infection），會自動產生大量突變；這裡手動挑最關鍵的幾個，成本比較低。

---

## 動手做

### 在你的 portfolio 開啟這條規則

在 portfolio repo 根目錄加 `.l10nrc.yml`：

```yaml
sourceLocale: zh-TW
rules:
  content-parity:
    pairs:
      - source: content/blog
        translations:
          en: content/i18n/en/blog
```

之後改成對稱的資料夾結構時（`content/zh-TW/blog`、`content/en/blog`），只要改 `source` 和 `translations` 的路徑。projects 也要檢查的話，在 `pairs` 再加一組。

### 在本機跑

在 portfolio 的目錄下，用 ai-platform 的 CLI：

```bash
node ../ai-platform/packages/cli/src/cli.ts --all
```

你現在會看到 1 個 warning，就是 AGENTS.md 那篇英文版的結語。

### 加到 portfolio 的 CI

```yaml
# .github/workflows/l10n-review.yml
name: l10n-review
on: pull_request
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: GavinLin512/ai-platform@main
        with:
          fail-on: error   # 這條規則只回報 warning 和 info，不會讓 CI 失敗
```

之後每個 PR，問題都會直接標在 **Files changed** 對應的行上。

## Laravel 對照表

| 這一輪 | Laravel／PHP |
|---|---|
| mdast 語法樹 | `league/commonmark` 的 AST（Laravel 的 `Str::markdown()` 底層就是它） |
| front matter | `spatie/yaml-front-matter` |
| 原文和翻譯的資料夾對應 | `lang/en/` 和 `lang/zh_TW/` 底下同名的檔案 |
| 突變測試 | Infection（`infection/infection`） |
| `git log -S` 找 commit | 一樣，git 不分語言 |

## 動手練習

1. **修掉那個 bug**：把 AGENTS.md 英文版的結語改成五篇，再跑一次 CLI，確認發現消失了。
2. **表格**：你的文章現在沒有表格，但 `blog/[slug].vue` 已經加了表格的樣式。在 `outlineMarkdown()` 加上表格的行數和欄數，兩邊要一致。（提示：表格是 GFM 擴充語法，要加 `mdast-util-gfm` 和 `micromark-extension-gfm`）
3. **YAML 資料檔**：`timeline.yml`、`skills.yml` 分語系之後，也會有「該翻的欄位」和「不該動的欄位」（`year`、`level`）。這條規則要怎麼延伸到 YAML 檔？
4. **中文粗體的陷阱**：`decisions.md` 記錄過「`**重點。**後文` 這種寫法，星號會原樣顯示」。寫一條規則抓出這種寫法。（提示：parse 之後，如果文字節點裡還留著 `**`，就表示那個粗體沒有生效）
5. **思考題**：「沒有中文的行必須相同」對中英文章很準，但如果是英文和法文（都是拉丁字母），這個方法就不能用了，所以規則這時只比對行數。還有什麼方法可以分辨「翻譯過的註解」和「被改過的程式碼」？

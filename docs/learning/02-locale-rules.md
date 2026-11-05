# 階段 1（續）：語系檔規則

這一輪新增兩條規則：`locale-keys`（key 缺漏或多出來）與 `locale-placeholders`（placeholder 不一致）。它們和上一條 `no-hardcoded-string` 有一個根本差異：**判斷一個檔案對不對，需要讀其他檔案**。

## 這一輪完成了什麼

- 規則引擎改成非同步，規則可以透過 `RepoReader` 讀取 PR 沒改到的檔案
- 從路徑自動辨識語系檔：`locales/zh-TW.json`、`lang/ja.json`、`public/locales/ko/common.json`
- `locale-keys`：source（預設 `en`）新增的 key 其他語系沒有；翻譯檔多出 source 沒有的 key，並提示「你是不是要找…」
- `locale-placeholders`：翻譯的 placeholder 跟 source 不一致、ICU 語法壞掉、i18next 專案裡寫成單大括號
- 測試從 54 個增加到 108 個，示範檔放在 `examples/locales/`

---

## 概念 1：規則需要讀「沒改到的檔案」→ `RepoReader`

PR 只改了 `en.json`，但要知道 `ja.json` 缺不缺 key，就得讀 `ja.json`。問題是：從哪裡讀？

- GitHub App：透過 GitHub API
- 測試：從記憶體裡的假資料
- 之後的 CLI：從本機檔案系統

如果規則直接呼叫 GitHub API，就沒辦法測試，也沒辦法拿去做 CLI。所以定義一個介面，讓規則只依賴這個介面（`src/core/types.ts`）：

```ts
interface RepoReader {
  readFile(path: string): Promise<string | undefined>;
  listDir(path: string): Promise<DirEntry[]>;
}
```

目前有兩種實作：`memoryReader`（測試用，`src/core/reader.ts`）和 `githubReader`（`src/github/reader.ts`）。

這就是**依賴反轉**。Laravel 對照：`Storage::disk('local')` 和 `Storage::disk('s3')` 背後都實作同一個 `Filesystem` contract，你的程式碼不需要知道檔案實際存在哪裡。

### 快取 Promise，而不是快取結果

三個語系檔都改了的話，每個檔案的檢查都會去讀其他兩個檔案，同一個檔案會被讀很多次。`cachedReader` 把讀取結果快取起來，而且快取的是 **Promise 本身**：兩個請求同時要讀 `en.json` 時，第二個會拿到第一個還沒完成的 Promise，總共只發出一次 API 請求。

## 概念 2：同步規則與非同步規則共存

引擎改成 `async` 之後，`Rule.check` 的回傳型別變成 `Finding[] | Promise<Finding[]>`。不過 `no-hardcoded-string` 只看單一檔案，不需要非同步，所以它宣告一個更窄的型別：

```ts
interface NoHardcodedStringRule extends Rule {
  check(file: SourceFile): Finding[];   // 少一個參數、回傳型別更窄，仍然相容
}
```

TypeScript 允許子型別的方法**參數更少、回傳更窄**。這樣舊的測試可以照常同步呼叫，不用全部改成 `await`。

## 概念 3：用平台內建的 CLDR 資料，不要自己維護清單

「`zh-TW` 是語系、`common` 不是」這件事，不需要自己列一張語系清單。Node 內建 Unicode 的 CLDR 資料，透過 `Intl` API 就能查詢：

| API | 用途 | 例子 |
|---|---|---|
| `Intl.DisplayNames` | 判斷是不是語系代碼 | `of("zh-TW")` → `"Chinese (Taiwan)"`，`of("common")` → `undefined` |
| `Intl.PluralRules` | 這個語言有哪些複數形 | 見概念 4 |
| `Intl.ListFormat` | 自然地列出清單 | `["ja", "ko", "zh-TW"]` → `"ja, ko, and zh-TW"` |

不過光靠「檔名是語系代碼」還不夠精準：`src/data/es.json` 的 `es` 是西班牙文代碼，但這個檔案很可能跟翻譯無關。所以規則還要求路徑上層必須有 `locales/`、`lang/`、`i18n/`、`messages/` 這類目錄（`src/core/locale/paths.ts`）。又一次 precision 優先。

## 概念 4：複數形，亞洲語系最容易被誤判的地方

i18next 把複數形存成不同的 key：`item_one`、`item_other`。天真的規則會說：「`en.json` 有 `item_one`，`ja.json` 也要有」。

但各語言的複數形數量不一樣：

| 語言 | 複數形 |
|---|---|
| 中文、日文、韓文、泰文、越南文 | `other`（只有一種） |
| 英文 | `one`、`other` |
| 法文 | `one`、`many`、`other` |
| 俄文 | `one`、`few`、`many`、`other` |
| 阿拉伯文 | `zero`、`one`、`two`、`few`、`many`、`other` |

日文本來就沒有單複數之分，`ja.json` **不應該**有 `item_one`。沒處理這一點的工具，會在每個 CJK 專案的每個複數 key 上誤報。`src/core/locale/plural.ts` 用 `Intl.PluralRules` 判斷某個語言需不需要某個複數形。這正是這個工具「主打亞洲語系」的實際意義。

反過來也一樣：俄文的 `item_few` 在英文 source 裡找不到，但它是合法的複數形，不是多出來的 key。

## 概念 5：ICU MessageFormat 要用 parser，不要用正規表達式

```
{count, plural, one {# item} other {{name} has # items}}
```

這一行有兩個參數（`count`、`name`），`#` 不是參數，大括號還有巢狀。用正規表達式處理很快就會出錯，所以這裡用 FormatJS 的官方解析器（`@formatjs/icu-messageformat-parser`）。

**這一輪測試抓到的真實 bug**：一開始的判斷邏輯是「看到 `{{` 就當成 i18next」，但上面那行 ICU 的 `other {{name} ...` 也出現了 `{{`，結果被誤判，一個參數都沒抓到。修正方式是調整判斷順序：**先用嚴格的 ICU 解析器試，失敗了才當成 i18next**。i18next 的 `{{name}}` 一定無法通過 ICU 解析，所以這個順序不會誤判。

教訓：有嚴格的 parser 可用時，先用它，啟發式判斷放在後面。

## 概念 6：JSON 沒有行號 → 借用 TypeScript 的 JSON AST

`JSON.parse` 只給你資料，不會告訴你 `"checkout"` 在第幾行，但 review 留言需要行號。這裡直接用 ts-morph 已經內建的 TypeScript 解析器（`ts.parseJsonText`）取得每個 key 的位置（`src/core/locale/json.ts`），**不需要新增套件**。

## 概念 7：問題要報在「需要修正的地方」，而且只報一次

| 問題 | 報在哪裡 | 為什麼 |
|---|---|---|
| source 新增的 key，ja 沒有 | source 那一行 | ja 缺的那一行不存在，沒辦法在上面留言 |
| ja 多出 source 沒有的 key | ja 那一行 | 要修的就是這一行 |
| zh-TW 的 placeholder 跟 source 不同 | zh-TW 那一行 | 要修的就是這一行 |
| source 改了 placeholder，ja 沒跟著改 | source 那一行 | ja 沒在這個 PR 裡，沒辦法在上面留言 |

最後一種情況要小心：如果 zh-TW **也在同一個 PR 裡**，同一個問題會在 source 和 zh-TW 各報一次。所以 `RuleContext.changedFiles` 會告訴規則「這個 PR 還改了哪些檔案、哪幾行」，讓 source 那邊把問題留給 zh-TW 自己報。

## 概念 8：用突變測試確認測試真的有用

測試一次全過時，要懷疑一下：它們真的抓得到錯誤嗎？這一輪我做了兩次**突變測試**（mutation testing）：

1. 故意把「這個語言需不需要這個複數形」改成永遠回傳 `true` → 「不要求 CJK 提供它們沒有的複數形」那個測試失敗了 ✅
2. 故意關掉跨檔案去重 → 「只報一次」那個測試失敗了 ✅

兩次都**剛好由對應的那個測試**抓到，代表測試真的在檢查關鍵邏輯。這件事有工具可以自動做：JS 有 Stryker，PHP 有 Infection。

---

## Laravel 對照表

| 這一輪 | Laravel |
|---|---|
| `RepoReader` 介面 + 多種實作 | `Filesystem` contract + local / s3 disk |
| `memoryReader` | `Storage::fake()` |
| `cachedReader` | `Cache::remember()`，但快取的是 Promise |
| `lang/en.json` 也能被辨識 | Laravel 的 JSON 翻譯檔 |
| 突變測試 | Infection |

## 動手練習

1. **Laravel placeholder**：Laravel 的翻譯用 `:name` 當 placeholder（例如 `"Welcome, :name"`）。在 `src/core/locale/placeholders.ts` 加上這種語法。
   想一想：`"Note: free shipping"` 裡的 `: free` 不是 placeholder，`"Ratio 16:9"` 也不是，你的規則要怎麼避免誤判？
2. **自己做突變測試**：把 `src/core/locale/suggest.ts` 裡的 `maxDistance` 改成 `0`，跑測試，看看哪個測試失敗。如果沒有任何測試失敗，代表缺了一個測試，請補上。
3. **彙整留言**：新增一整個 source 語系檔、裡面有 50 個 key 時，目前會產生 50 則「ja 缺這個 key」的留言。設計一種彙整方式，例如超過 5 個就合併成一則。要改哪裡？fingerprint 要怎麼設計？
4. **挑戰題：`.l10nrc.yml`**：讓使用者在 repo 根目錄用設定檔指定 `sourceLocale` 和 `localeDirs`。提示：`RepoReader` 已經能讀 repo 裡的任何檔案。

## 下一步

- 規則：金額、日期沒用 `Intl.NumberFormat`／`Intl.DateTimeFormat`
- `.l10nrc.yml` 設定檔
- 之後進入階段 2：用 LLM 判斷語境（兩岸用語、語意偏移、語氣一致）

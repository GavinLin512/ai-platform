# 階段 2：LLM 層

這一輪加上兩條需要「理解語境」的檢查，這是這個工具跟一般 i18n linter 的差別：

- `zh-tw-terminology`：台灣繁中字串裡的中國大陸用語
- `translation-meaning`：翻譯的意思跑掉了，或語氣跟產品其他地方不一致

程式碼在 `packages/ai`。

## 先說清楚驗證到哪裡

你選了「先不用 API key」，所以：

- ✅ 確定性的部分都測過：候選詞偵測、批次處理、過濾、驗證步驟的邏輯、失敗處理、成本計算、資料庫紀錄（用假的 LLM 客戶端，29 個測試）
- ✅ eval 的免費基準線實際跑過：precision 80.6%、recall 100%
- ❌ **還沒有呼叫過真的 Claude API**。以下幾件事要等你有 key 之後才知道：模型實際的準確率、驗證步驟到底能減少多少誤報、prompt 快取的命中率，以及 API 是否接受「結構化輸出 + `fallbacks`」這個組合（SDK 的型別允許，但我沒有實測）

有了 key 之後，第一件事就是跑下面「動手練習」的第 1 題。

---

## 架構：規則先篩，LLM 判斷，再驗證一次

```
新增的 zh-TW 字串
   │
   ├─ ① 字典預篩（OpenCC 來回轉換 + 電商用語補充表）     免費
   │     沒有候選詞 → 結束，不呼叫 LLM
   ▼
   ② LLM 依語境判斷：哪些真的是大陸用語？                  1 次呼叫 / 40 個字串
   │     過濾掉「原文裡根本沒有」的詞
   ▼
   ③ 驗證：另一次呼叫逐一確認，不確定就不報                1 次呼叫，只送有問題的
   ▼
   留言
```

這就是階段 0 討論過的設計：**能用規則判斷的不花 token，LLM 只處理需要理解語境的部分**。成本跟 PR 的大小成正比，跟整個 repo 的大小無關。

## 概念 1：實測 OpenCC，數據說明了為什麼需要 LLM

OpenCC 是開源的繁簡轉換工具，附有兩岸用語對照字典。做法是把台灣繁中先轉成簡體，再轉回「台灣用語」。結果如果不一樣，就代表這個字串**可能**有問題。

實際測試的結果：

| 情況 | 例子 |
|---|---|
| ✅ 正確抓到 | 軟件→軟體、服務器→伺服器、視頻→影片、內存→記憶體、简体字 |
| ❌ 漏抓（多半是**電商用語**） | 結算（台灣說結帳）、包郵（免運）、賬號（帳號）、質量（品質）、打印發票 |
| ❌ 不懂語境 | 「感謝您的**支持**」在台灣就是說支持，OpenCC 卻建議改成「支援」 |
| ❌ 一詞多義 | 文件（document 不用改，file 才改成檔案）、項目（item 不用改）、程序（procedure 不用改） |
| ❌ 字典本身出錯 | 用戶名稱 → 「使用者名稱**稱**」 |

所以 OpenCC 只負責找候選，漏抓的部分用補充表補上（`src/terminology/detect.ts` 的 `SUPPLEMENT`），**最後的判斷交給 LLM**。

## 概念 2：eval 把「感覺有用」變成數字

`packages/ai/eval/cases/terminology.jsonl` 有 42 個標好答案的案例：25 個真的有大陸用語，17 個是台灣的正確用法。後者刻意包含很多陷阱：支持（endorse）、文件（document）、項目（item）、並行（台灣的 concurrent，跟大陸剛好相反的「鏡像陷阱」）。

只用字典的基準線：

| | 數值 |
|---|---|
| precision（報出來的有多少是對的） | **80.6%** |
| recall（該抓的抓到多少） | **100%** |
| 誤報 | 6 個 |

**6 個誤報剛好全部都是需要語境才能判斷的詞**：支持、文件、項目、查看、優化、程序。也就是說，LLM 的工作範圍很明確：保持 100% recall，同時把 precision 從 80.6% 往上推。

`test/eval.test.ts` 把這個基準線鎖住了：之後改字典時，如果漏抓了任何一個，或是多出新的誤報，測試就會失敗。

### 小心「對著考卷調參數」

`打印發票` 一開始沒被抓到，我把「打印」加進補充表，recall 就變成 100% 了。這次可以接受，因為打印確實是大陸用語（台灣說列印）。但如果每次都是看 eval 哪裡錯就補哪裡，最後得到的只是一個「很會考這份考卷」的系統。

案例越來越多之後，應該把 eval 拆成兩份：一份用來調整（train），一份只拿來最後驗收（test）。

## 概念 3：結構化輸出，而且不要完全相信它

```ts
const response = await client.beta.messages.parse({
  model,
  output_config: { effort, format: betaZodOutputFormat(JudgeOutput) },
  ...
});
response.parsed_output; // 已經用 zod 驗證過的物件
```

用 zod schema 定義輸出格式，SDK 會轉成 JSON schema 交給 API，再把回應驗證成型別安全的物件。這比「請回傳 JSON」然後自己 `JSON.parse` 可靠得多。

但格式正確，**不代表內容正確**，所以程式還做了兩層防禦：

- **模型回報的詞必須真的出現在原文裡**，否則忽略。模型偶爾會「發明」問題
- **`kind` 只接受 `meaning` 或 `tone`**，其他值一律忽略

突變測試確認了這兩層防禦都有測試在守著。

**一個實作細節**：zod 的 `enum` 轉成 JSON schema 時，SDK 會把它移進 `description`，代表 API 端不會強制限定在列舉值裡。所以 schema 裡改用 boolean 和一般字串，列舉值在程式端驗證。

## 概念 4：驗證步驟，用第二次呼叫換 precision

第一次呼叫負責「找出可能的問題」，第二次呼叫只看被標記的項目，判斷標準更嚴格：「不確定就不報，錯誤的留言比漏掉一個問題更糟」。

這要多付一次 API 呼叫的錢，但只送有問題的項目，所以通常很便宜。值不值得，可以用 eval 量：

```bash
pnpm --filter @l10n-review/ai eval --mode llm
```

```bash
pnpm --filter @l10n-review/ai eval --mode llm --no-verify
```

比較兩次的 precision 和成本，就知道驗證步驟值多少錢。

## 概念 5：LLM 失敗不能拖垮整個 review

API 可能逾時、過載，或被安全分類器拒絕（`stop_reason: "refusal"`）。如果 LLM 規則直接丟出錯誤，**整個 review 都會失敗**，連確定性規則找到的問題也一起不見。

所以 `src/batch.ts` 的 `tryComplete()` 會接住錯誤，把失敗記錄在 `UsageMeter.failures`，這一批就不產生任何結果，其他規則照常運作。worker 會在 log 裡記下這些失敗。

被安全分類器拒絕的情況，還有第一道防線：請求帶了 `fallbacks: "default"`。被拒絕時，API 會自動換另一個模型重跑。只有連備援模型也拒絕時，才會丟出 `LlmRefusalError`。

## 概念 6：prompt 快取與成本

- **system prompt 是常數**（`src/prompts.ts`），每次呼叫的位元組都一模一樣，加上 `cache_control` 就能被快取重用。會變動的內容（要檢查的字串）一律放在 user message
- **快取有最小長度門檻**，太短的 prompt 會默默不快取。要看 usage 裡的 `cache_read_input_tokens` 才知道有沒有生效
- **成本**：`src/pricing.ts` 依官方價格計算（Opus 5.5：輸入 $4、輸出 $20、快取讀取 $0.20，單位是每百萬 token）。每次呼叫都會寫進資料庫的 `llm_usage` 表，金額用 `numeric` 型別，**不用浮點數**

模型和 effort 都可以在 `.l10nrc.yml` 調整。換成 Sonnet 或 Haiku 會便宜很多，但準確率可能下降，這正是 eval 要回答的問題。不要憑感覺換。

## 概念 7：檢索，以及為什麼暫時不用資料庫

`translation-meaning` 檢查會附上同一個產品的其他翻譯當作風格範例，讓模型知道這個產品用「您」還是「你」。範例的排序方式：

- **原文的字元 trigram 相似度**（跟 Postgres 的 `pg_trgm` 是同一個演算法）
- **同一個 key namespace** 加分（`cart.*` 跟 `cart.checkout` 是同一組）

當初的規劃是用 Postgres 的 `pg_trgm` 或 pgvector 做翻譯記憶。實作時我改成**在記憶體裡算**，原因是：review 時本來就已經把這些語系檔載入記憶體了，再寫進資料庫查一次，只是多繞一圈，結果完全一樣。

資料庫索引真正值得的時機是：要**跨 repo** 共用翻譯記憶，或語系檔大到記憶體裡算不動。到那時候再加就好，`Example` 介面不用改。這是「不要為了用而用」的判斷，面試時也值得拿出來講。

## Laravel 對照表

| 這一輪 | Laravel |
|---|---|
| `LlmClient` 介面 + `fakeLlmClient` | 依賴 contract，測試時用 `Http::fake()` |
| zod schema 驗證 LLM 輸出 | 用 Form Request 驗證外部輸入：不信任任何外部資料 |
| `tryComplete()` 吞掉錯誤並記錄 | 在 `report()` 記錄例外但不讓請求失敗 |
| `llm_usage` 表 | 自己記錄第三方 API 的用量與帳單 |

## 啟用 LLM 檢查

1. 在 `apps/github-app/.env` 加上 `ANTHROPIC_API_KEY=…`
2. 可以在 `.l10nrc.yml` 調整模型和 effort（見 README 的 Configuration）
3. 重啟 `pnpm dev`。啟動 log 會顯示 `"llmChecks":true`

部署到 Cloud Run 時，在 Secret Manager 建立 `anthropic-api-key`，再照 `.github/workflows/deliver.yml` 裡的註解加一行設定。

## 動手練習

1. **（有 key 之後最重要的一件事）量出真實數字**：
   ```bash
   pnpm --filter @l10n-review/ai eval --mode llm
   ```
   ```bash
   pnpm --filter @l10n-review/ai eval --mode llm --no-verify
   ```
   ```bash
   pnpm --filter @l10n-review/ai eval --suite meaning --mode llm
   ```
   然後比較：
   ```bash
   uv run packages/ai/eval/report.py packages/ai/eval/results/*.json
   ```
   LLM 有沒有把那 6 個誤報修掉？有沒有新的漏抓？驗證步驟值不值那個錢？
2. **換模型比較**：用 `--model claude-sonnet-5-5` 和 `--model claude-haiku-5-5` 各跑一次，比較 precision 和成本。便宜的模型夠用嗎？
3. **擴充 eval**：從你做過的跨境電商專案裡，挑 20 個真實的大陸用語或語意錯誤的例子加進 `cases/`。然後把案例拆成 train 和 test 兩份
4. **新規則：詞彙表**：在 `.l10nrc.yml` 加一個 `glossary`（例如 cart 一律翻成「購物車」，不能翻成「購物籃」），寫一條**確定性**規則檢查。想一想：這條規則需要 LLM 嗎？
5. **Python 練習**：`eval/report.py` 目前只印表格。用 matplotlib 畫出「precision 對成本」的散佈圖，比較不同的模型和設定

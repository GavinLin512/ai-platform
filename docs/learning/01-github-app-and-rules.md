# 階段 1：GitHub App + 規則層

這份筆記說明階段 1 的程式碼背後的概念。建議搭配原始碼一起讀，每一節都會標出對應的檔案。

## 這一階段完成了什麼

- 一個可以接收 GitHub webhook 的 HTTP 伺服器（Hono）
- PR 開啟或 push 新 commit 時，自動抓出變更的檔案與 diff
- 第一條規則 `no-hardcoded-string`：用 AST 找出 JSX 裡沒走 i18n 的寫死字串
- 把結果整理成**一則** review，在對應行留言，重複 push 不會重複留言
- CI：每個 PR 自動跑 lint、型別檢查、測試

## 一個 PR 進來會發生什麼

```
GitHub ──POST /api/github/webhooks──▶ server.ts
                                        │ 1. 驗證簽章（不對就回 401）
                                        │ 2. 立刻回 202
                                        ▼
                                   github/app.ts（背景執行）
                                        │ 3. 依事件類型分派：pull_request.opened / synchronize / reopened
                                        ▼
                                   github/review.ts
                                        │ 4. 列出變更檔案，解析 diff 取得「新增的行號」
                                        │ 5. 抓每個檔案的完整內容
                                        ▼
                                   core/engine.ts  ← 純函式，不碰 GitHub
                                        │ 6. 跑規則，只保留落在新增行的結果
                                        ▼
                                   github/review.ts
                                        │ 7. 比對舊留言的 fingerprint，去掉重複的
                                        │ 8. 一次送出一則 review
                                        ▼
                                      PR 上出現留言
```

`src/core` 完全不 import `src/github`。這個邊界讓規則引擎可以獨立測試，階段 5 也能直接拿去做 CLI 和 GitHub Action。

---

## 概念 1：GitHub App，而不是 Personal Access Token

| | Personal Access Token | GitHub App |
|---|---|---|
| 身分 | 就是你本人 | 獨立的 bot 帳號（`xxx[bot]`） |
| 範圍 | 你能存取的所有 repo | 只有安裝它的 repo |
| 權限 | 粗 | 細到「PR 可寫、程式碼唯讀」 |
| Token 期限 | 長期 | 每個安裝的 token 1 小時就過期 |

驗證流程分兩段：

1. 用 App 的 **private key** 簽一個 JWT（效期 10 分鐘），代表「我是這個 App」
2. 拿 JWT 換某個安裝（installation）的 **access token**，代表「我在這個 repo 上行動」

`octokit` 的 `App` 類別會自動處理這兩步。webhook handler 拿到的 `octokit` 已經是該 repo 的身分（見 `src/github/app.ts`）。

## 概念 2：Webhook 簽章驗證（HMAC）

任何人都能對你的公開網址發 POST，所以必須確認請求真的來自 GitHub：

1. 建立 App 時，你和 GitHub 共享一組 **webhook secret**
2. GitHub 每次發送時，計算 `HMAC-SHA256(secret, 原始 body)`，放在 `X-Hub-Signature-256` header
3. 伺服器用同一組 secret 重算一次，結果一致才處理

兩個常見的坑：

- **一定要用原始 body**。先 `JSON.parse` 再 `JSON.stringify`，空白或欄位順序一變，簽章就對不上。所以 `server.ts` 用的是 `c.req.text()`
- **比對要用固定時間比較**（constant-time），避免 timing attack。`octokit` 內部已經用 `timingSafeEqual` 處理

`test/server.test.ts` 用 `node:crypto` 自己算簽章，測了「正確」、「secret 錯誤」、「body 被竄改」三種情況，可以從這裡看懂整個機制。

## 概念 3：先回 202，再背景處理

GitHub 等 webhook 回應最多 10 秒，超過就判定這次送達失敗。抓檔案加上之後的 LLM 呼叫很容易超過 10 秒，所以 `server.ts` 驗證完簽章就先回 `202 Accepted`，review 改在背景執行。

目前的做法是「同一個行程裡不 await」，有兩個已知缺點，階段 3 會處理：

- 行程重啟時，正在跑的 review 會直接遺失
- Cloud Run 預設在回應送出後會限制 CPU，背景工作可能跑不完

正式的解法是**佇列**（Cloud Tasks、Pub/Sub 或 BullMQ + Redis）。webhook 只負責把工作放進佇列，由 worker 處理。

## 概念 4：為什麼用 AST，而不是正規表達式

用正規表達式找 `"..."`，會把下面這些全部抓出來：

```tsx
<div className="cart-item">                     {/* CSS class，不是文案 */}
  {status === "active" && <Badge />}            {/* 比較用的值 */}
  <p>Add to cart</p>                            {/* ✅ 這才是要抓的 */}
</div>
```

AST（Abstract Syntax Tree，抽象語法樹）會把程式碼解析成一棵樹，每個節點都知道自己的「種類」：

```
JsxElement  <button title="Remove">Add to cart</button>
├─ JsxOpeningElement
│   └─ JsxAttribute  title = StringLiteral "Remove"   ← 檢查（title 在清單裡）
├─ JsxText "Add to cart"                               ← 檢查
└─ JsxClosingElement
```

所以規則可以精準指定「只看 `JsxText`、只看 `title` 和 `placeholder` 這幾個屬性」。想看任意程式碼的 AST 長什麼樣子，可以貼到 <https://ts-ast-viewer.com>。

對應檔案：`src/core/rules/no-hardcoded-string.ts`。重點在 `forEachDescendant` 裡的三個分支，以及 `userFacingLiterals()` 如何只走進「字串一定會顯示在畫面上」的運算式（三元、`&&`、`??`、`+`）。

另一個細節：判斷「是不是文字」用的是 Unicode 屬性 `\p{L}`（任何語言的字母），不是 `[a-zA-Z]`。這樣中文、日文、泰文都能抓到，而 `—`、`100%`、`&nbsp;` 會被排除。這對一個主打亞洲語系的工具很重要。

## 概念 5：只審新增的行，寧可漏抓也不要誤報

審查 bot 最常被移除的原因是**太吵**。所以階段 1 做了這些取捨：

- **只看這個 PR 新增的行**：舊程式碼的問題不是這次作者的責任。`src/core/diff.ts` 解析 unified diff 的 `@@ -a,b +c,d @@`，算出新檔案裡被新增的行號
- **只檢查幾乎一定會顯示給使用者看的位置**：`className`、`href`、函式參數、物件的值都不看
- **跳過**測試檔、Storybook、`<Trans>`（已經處理 i18n）、`<code>`、`<pre>`
- **一則 review 最多 30 則留言**，其餘下次 push 再補上

用術語來說，這是 precision（抓到的都是對的）優先於 recall（全部都抓到）。階段 2 加 LLM 後，也會用同樣的原則設計驗證步驟。

## 概念 6：冪等性與 fingerprint

同一個 PR 每 push 一次就會觸發一次 `synchronize`，GitHub 也可能重送同一個 webhook。如果每次都把所有問題重新留言一遍，PR 很快就會被洗版。

做法：每則留言最後藏一段 HTML 註解（GitHub 畫面上看不到）：

```
<!-- l10n-review:fp=3f9a1c0b2e7d4a65 -->
```

fingerprint = `雜湊(規則 ID + 檔案路徑 + 字串內容)`。刻意**不包含行號**：在上方加幾行程式碼，同一個問題的行號會改變，但 fingerprint 不會變。下次 review 前先讀回既有留言，已經報過的就跳過（`src/github/format.ts`、`src/github/review.ts` 第 4 步）。

## 概念 7：Node 直接執行 TypeScript

Node 22.18 起內建 type stripping：執行 `.ts` 檔時直接把型別註記拿掉，**不需要編譯步驟**。所以 `package.json` 裡的 `dev` 和 `start` 都是直接 `node src/index.ts`。

代價與對應設定（見 `tsconfig.json`）：

- 只能用「拿掉型別後就是合法 JS」的語法，不能用 `enum`、`namespace`、constructor 參數屬性。`erasableSyntaxOnly` 會在型別檢查時擋下這些
- import 要寫完整副檔名 `./diff.ts`（`allowImportingTsExtensions`）
- Node 執行時**完全不檢查型別**，所以型別錯誤只能靠 `pnpm typecheck` 和 CI 抓。`tsc` 在這個專案裡只做檢查，不輸出檔案（`noEmit`）

好處是階段 3 的 Docker image 會很單純：複製原始碼、安裝套件、`node src/index.ts`，不用另外處理建置產物。

---

## Laravel 對照表

| 這個專案 | Laravel |
|---|---|
| `server.post("/api/github/webhooks", …)`（Hono） | `Route::post(...)` + Controller |
| `env.ts`（zod schema） | `config/*.php` + `env()`，但多了型別驗證，設定錯誤在啟動時就會爆出來 |
| webhook 簽章驗證 | Cashier 的 `VerifyWebhookSignature` middleware |
| 先回 202、背景處理（之後換佇列） | `ReviewPullRequest::dispatch(...)` 丟進 queue |
| fingerprint 去重 | `ShouldBeUnique` job／idempotency key |
| `src/core` 不依賴 `src/github` | 把業務邏輯放在 Service／Action class，不直接依賴 HTTP 層 |
| Vitest | Pest／PHPUnit |
| `test/github/review.test.ts` 的假 Octokit | `Http::fake()`／Mockery |
| pnpm + `pnpm-lock.yaml` | Composer + `composer.lock` |
| Biome | Laravel Pint |
| `tsc`（只做型別檢查） | PHPStan／Larastan |

## 動手練習

建議每一題都**先寫一個會失敗的測試，再改程式**，跑 `pnpm test:watch` 邊改邊看。

1. **暖身**：把 `aria-description` 加進預設屬性清單（`DEFAULT_ATTRIBUTES`），並在 `test/core/no-hardcoded-string.test.ts` 補一個案例。
2. **AST 練習**：讓規則也抓 `alert("...")`、`confirm("...")`、`toast.error("...")` 的字串參數。
   提示：`Node.isCallExpression(node)`，再看 `node.getExpression().getText()` 是不是在清單裡。注意這些呼叫不在 JSX 裡，所以 `appliesTo` 也許要放寬到 `.ts`。
3. **取捨題**：fingerprint 不含行號，所以同一個檔案裡第二次出現的 `"Checkout"`，如果是後來才 push 的，就不會被留言。這是故意的嗎？如果要修，你會怎麼改 fingerprint？改了之後又會有什麼副作用？（沒有標準答案，想清楚就好）
4. **實際跑一次**：照 README 的「Running it against a real repository」建一個測試用 GitHub App，在你自己的測試 repo 開一個 PR，看到 bot 留言。

## 下一步

階段 1 還剩下這些，完成後再進階段 2（LLM）：

- 讀取 `.l10nrc.yml` 設定檔（規則的 options 已經預留好，只差載入）
- 規則：各語系 key 缺漏（`en.json` 有、`zh-TW.json` 沒有）
- 規則：placeholder 不一致（`{count}`、`{{name}}`、`%s` 在翻譯裡不見了）
- 規則：金額、日期沒用 `Intl.NumberFormat`／`Intl.DateTimeFormat`

# 階段 4：Next.js Dashboard

GitHub App 每次 review 都會把結果寫進 Postgres。這一輪用 Next.js 把這些資料變成一個頁面：每天新增多少問題、各規則的問題有多少被修掉、LLM 花了多少錢、最近的 review 紀錄。

程式碼在 `apps/dashboard`，查詢在 `packages/db/src/dashboard.ts`。

## 這一輪完成了什麼

- 4 個統計卡片、每日新增問題的長條圖、各規則的修正率、各模型的成本、最近的 review
- 明暗兩種模式，手機版不會水平捲動
- GitHub 登入加上允許清單，正式環境沒設定時**拒絕提供服務**
- 示範資料產生器（30 天、3 個 repo）
- Dockerfile、docker compose、K8s、CI 和 Cloud Run 部署
- 測試：176 → 192 個

## 實際驗證了什麼

- 用示範資料跑起來，**截圖用眼睛檢查**明亮、深色、手機三種版本，修了 4 個只有看畫面才發現的問題（見概念 7）
- 登入的每種情況都實測過：沒登入會被導向 GitHub、偽造的簽章、竄改過的內容、不在允許清單的使用者都被擋下，有效的 session 才看得到頁面
- Docker image 實際跑起來：頁面、靜態檔案、健康檢查都正常
- ❌ **完整的 GitHub OAuth 來回流程沒有實測**：要在瀏覽器登入你的 GitHub 帳號才能完成

---

## 概念 1：Server Components

```tsx
export default async function DashboardPage() {
  const [summary, perDay, rules, costs, runs] = await Promise.all([...]); // 在伺服器上查詢
  return <main>…</main>;
}
```

頁面本身是 **async 的 React 元件，只在伺服器上執行**：直接查資料庫，把渲染好的 HTML 送給瀏覽器。資料庫的連線字串和查詢邏輯都不會出現在瀏覽器裡。

整個頁面只有長條圖需要互動（hover 顯示 tooltip），所以只有 `FindingsChart.tsx` 開頭寫了 `"use client"`，瀏覽器也只需要下載這一個元件的 JavaScript。

**Laravel 對照**：很像 Blade 在伺服器端渲染整頁，只有一小塊用 Alpine.js 或 Livewire 處理互動。

## 概念 2：用 SQL 做分析

查詢都寫成原生 SQL（`packages/db/src/dashboard.ts`），因為聚合查詢用 SQL 寫比用 query builder 好讀。三個值得學的技巧：

**① 「修正率」的定義**：一個問題被報出來之後，如果同一個 PR **最新**一次 review 裡已經沒有它的 fingerprint，就算已解決（修好了，或那段程式碼被移除了）。

```sql
latest as (
  select distinct on (repo, pull_number) id, repo, pull_number
  from reviews where status = 'completed'
  order by repo, pull_number, started_at desc      -- 每個 PR 只留最新的一筆
)
select rule_id,
       count(*) as reported,
       count(*) filter (where not exists (…)) as resolved   -- 條件計數
```

- `DISTINCT ON` 是 Postgres 特有的語法，用來取「每組的第一筆」。在 MySQL 要用 window function 或子查詢才做得到
- `count(*) filter (where …)` 可以在同一個查詢裡算出不同條件的數量

**② 沒有資料的日子也要出現在圖上**：

```sql
from generate_series(date_trunc('day', $since), date_trunc('day', now()), interval '1 day') as d
left join findings f on …
```

如果只 `group by` findings，沒有新問題的日子就**整天消失**，長條圖的時間軸會跳格，讀者以為是連續的。`generate_series` 先產生完整的日期序列，再 `left join` 資料，空的日子就是 0。

**③ 一個實際踩到的坑**：在 Drizzle 的原生 `sql` 樣板裡直接傳 `Date` 物件，驅動程式**不會自動轉換**（用 query builder 時才會）。解法是傳 ISO 字串，在 SQL 裡明確轉型：`${date.toISOString()}::timestamptz`。

### 測試共用資料庫時的另一個坑

`dashboard.test.ts` 和 `reviews.test.ts` 用同一個資料庫，而且都會清空資料表。Vitest 預設**平行**跑不同的測試檔，所以它們會互相刪掉對方的資料，測試時好時壞。解法是讓 db 套件的測試檔依序執行（`packages/db/vitest.config.ts` 的 `fileParallelism: false`）。

## 概念 3：資料視覺化的原則

這不是隨便挑顏色畫圖，而是照一套有規則的方法：

| 原則 | 在這個 Dashboard 的做法 |
|---|---|
| 先決定圖表形式 | 「這期間的總數」用統計卡片，「每天的變化」才用長條圖 |
| 單一系列不需要圖例 | 標題已經說明是什麼，多一個圖例只是重複 |
| 細長條、只有上方圓角 | 長條最寬 24px、頂端 4px 圓角、底部平貼基準線、彼此至少隔 2px |
| 只標重點數字 | 只在**最高的那一天**標數字，其他用 tooltip 和表格 |
| tooltip 不能是唯一的讀取方式 | 有「Show as table」可以看每一天的數字 |
| hover 和鍵盤要有一樣的體驗 | 每一天是一個真正的 `<button>`，Tab 聚焦時也會出現 tooltip |
| 深色模式要**另外挑顏色** | 不是把顏色反轉，而是為深色背景另外選的一組 |
| 狀態不能只靠顏色 | 完成、失敗都有 ✓ ✕ 圖示加文字 |
| 文字用文字的顏色 | 數字和標籤用黑灰色系，資料的顏色只用在圖形上 |

## 概念 4：自己實作 GitHub OAuth 登入

我**沒有用任何套件**，直接照 OAuth 2.0 的標準流程寫，這樣每一步都看得到：

```
① /api/auth/login
   產生隨機的 state，存在 cookie，導向 github.com/login/oauth/authorize
② 使用者在 GitHub 按「授權」，GitHub 帶著 ?code=…&state=… 導回 /api/auth/callback
③ 檢查 state 跟 cookie 裡的一樣（防止 CSRF）
④ 伺服器用 code + client secret 換 access token（伺服器對伺服器，瀏覽器看不到 secret）
⑤ 用 token 問 GitHub「這是誰」→ 得到 login
⑥ 比對允許清單 → 發出我們自己簽章的 session cookie
```

### 簽章 cookie

session 存在 cookie 裡，格式是 `base64(內容).base64(HMAC 簽章)`。只有伺服器知道 secret，所以：

- 改了內容中的任何一個字（例如把到期時間改長），簽章就對不上
- 不需要資料庫存 session

比對簽章用的是 `timingSafeEqual`（固定時間比較），跟筆記 01 的 webhook 簽章驗證是同一個道理。

cookie 的安全屬性：`httpOnly`（JavaScript 讀不到，就算有 XSS 也偷不走）、`secure`（只走 HTTPS）、`sameSite: lax`（降低 CSRF 風險）。

### Fail closed

正式環境（`NODE_ENV=production`）如果沒有設定登入，Dashboard 會**直接回 503，拒絕提供服務**，而不是默默變成公開頁面。設定錯誤的代價應該是「服務不能用」，而不是「資料外洩」。

我在驗證時就碰到這個機制：第一次用 `next start` 跑起來，頁面回了 503，這正是它該有的行為。

**Laravel 對照**：Laravel Socialite 幫你做完的事，這裡一步一步寫出來。session cookie 的概念跟 Laravel 的 encrypted cookie 類似。

## 概念 5：查官方文件，不要相信記憶

Next.js 16 把 `middleware.ts` **改名成 `proxy.ts`**，舊的名稱被標為 deprecated。如果憑記憶寫 `middleware.ts`，雖然還能跑，但用的是過時的寫法。

這次我是查了 Next.js 套件裡附的文件（`node_modules/next/dist/docs`）才確認的。框架更新很快，寫程式前先查目前版本的文件，是很實用的習慣。

## 概念 6：monorepo 裡的 Next.js

- **`transpilePackages: ["@l10n-review/db"]`**：db 套件 export 的是 TypeScript 原始碼，要讓 Next 當成 app 的程式碼一起編譯
- **`output: "standalone"` + `outputFileTracingRoot`**：Next 追蹤真正用到的檔案，產生一個獨立的伺服器。在 monorepo 裡要把追蹤的根目錄設成 repo 根目錄，不然會漏掉 `packages/` 底下的東西
- **把 migration 拆成獨立的進入點**：一開始 build 時出現警告，打包器把 `new URL("../drizzle", import.meta.url)` 當成要打包的資源，結果找不到。根本原因是 Dashboard **只讀資料，根本不需要 migration**，卻因為 import 了整個 db 套件而一起被打包。現在 migration 改從 `@l10n-review/db/migrate` 引入，只有 GitHub App 和 seed 腳本會用到

## 概念 7：截圖檢查找到的問題

測試和型別檢查都通過，但**實際看畫面**時還是發現了 4 個問題：

| 問題 | 原因 | 修法 |
|---|---|---|
| X 軸標籤擠成「Oct 20Oct 21」 | 每天都顯示標籤，寬度不夠 | 依可用寬度決定每 1、2、7 或 14 天顯示一次，**從今天往回算** |
| 手機版有 26px 水平捲動 | CSS Grid 的子元素預設 `min-width: auto`，被表格撐開 | 加上 `min-w-0`，表格改在卡片內部捲動 |
| 最右邊的「Nov 5」被切掉 | 置中對齊的標籤超出邊界 | 靠近右邊界時改成靠右對齊 |
| 表頭「ReportedResolved」黏在一起 | 表格欄位沒有間距 | 加上欄位間距，表頭不斷行 |

CSS Grid 的 `min-width: auto` 是前端最常見的版面陷阱之一，記住它。

---

## 動手做

### 本機看 Dashboard

```bash
docker compose up -d db
```

```bash
DATABASE_URL=postgres://l10n:l10n@localhost:5432/l10n pnpm --filter @l10n-review/db seed
```

```bash
DATABASE_URL=postgres://l10n:l10n@localhost:5432/l10n pnpm --filter @l10n-review/dashboard dev
```

打開 <http://localhost:3001>。開發模式不需要登入。

### 設定 GitHub 登入

GitHub App 本身就可以當 OAuth App 使用，不用另外建立：

1. App 設定頁 → **General** → 記下 **Client ID**，按 **Generate a new client secret**
2. 同一頁的 **Callback URL** 加上 `<Dashboard 網址>/api/auth/callback`，例如 `http://localhost:3001/api/auth/callback`
3. 照 `apps/dashboard/.env.example` 填好 4 個變數

### 部署到 Cloud Run

在筆記 05 的設定之外，再加上：

- **Repository variables**：`L10N_GITHUB_OAUTH_CLIENT_ID`、`DASHBOARD_ALLOWED_USERS`
- **Secret Manager**：`github-oauth-client-secret`、`dashboard-session-secret`

設定好之後，`deliver.yml` 的 `deploy-dashboard` job 就會開始執行。部署完成後，記得把 Cloud Run 給的網址加進 App 的 Callback URL。

## Laravel 對照表

| 這一輪 | Laravel |
|---|---|
| Server Component | Blade 在伺服器端渲染 |
| `"use client"` 的圖表 | Alpine.js／Livewire 的互動區塊 |
| `proxy.ts` | Middleware |
| 手寫的 OAuth 流程 | Laravel Socialite |
| 簽章 session cookie | encrypted cookie |
| `DB::select()` 原生 SQL | `packages/db/src/dashboard.ts` |

## 動手練習

1. **時間範圍篩選**：在頁面上方加一個「7 天／30 天／90 天」的選擇器，用 URL 的 `?days=7` 傳遞。為什麼用 URL 參數，而不是 React state？（提示：重新整理、分享連結）
2. **單一 repo 的頁面**：新增 `/repos/[owner]/[name]`，只顯示那個 repo 的資料。需要改哪些查詢？
3. **堆疊長條圖**：把每天的長條依規則分色堆疊。照資料視覺化的原則，需要圖例嗎？6 種規則要用哪 6 個顏色？
4. **思考題**：「修正率」把「那段程式碼被刪掉」也算成已解決。這個定義合理嗎？要怎麼區分「真的修好」和「刪掉了」？

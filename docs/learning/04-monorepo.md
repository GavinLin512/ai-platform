# Monorepo：為部署、Dashboard、CLI 做準備

這個 PR 沒有新功能，只是**搬家**：從單一套件變成 pnpm monorepo。之後的部署、Next.js Dashboard、CLI 都會是這個 repo 裡的獨立套件。

## 為什麼現在拆，而不是一開始就拆

一開始只有一個 app，拆成 monorepo 只會多出設定檔，沒有好處（YAGNI）。現在拆是因為接下來的三個 PR 都需要：

- **部署**：Dockerfile 和 CI 要知道最終的目錄結構。先拆再寫，才不用寫兩次
- **Dashboard**：Next.js 是另一個 app，要跟 GitHub App 共用資料庫的程式碼
- **CLI／Action**：要重用 `core` 的規則，但不需要任何 GitHub App 的程式碼

「等到真的需要才重構」也是一個值得記住的判斷：時機到了，重構的成本最低，而且你已經清楚知道要拆成什麼樣子。

## 現在的結構

```
packages/core        @l10n-review/core         規則引擎，沒有 GitHub、沒有網路
apps/github-app      @l10n-review/github-app   webhook 伺服器、review 流程
```

**`packages/` 放被別人使用的程式庫，`apps/` 放可以執行的應用程式**，這是 monorepo 常見的慣例。

## 概念 1：`workspace:*`

`apps/github-app/package.json` 裡：

```json
"@l10n-review/core": "workspace:*"
```

意思是「用這個 repo 裡的那個套件，不要去 npm 下載」。pnpm 會在 `apps/github-app/node_modules/@l10n-review/core` 建立一個 symlink，指向 `packages/core`。改了 core 的程式碼，github-app 馬上就能用到，不用發布任何東西。

Laravel 對照：Composer 的 `path` repository，例如在 `composer.json` 裡用 `"type": "path", "url": "../packages/my-package"` 開發自己的套件。

## 概念 2：直接 export TypeScript 原始碼

```json
"exports": { ".": "./src/index.ts" }
```

一般發布到 npm 的套件會先編譯成 `.js` 再 export。這裡是 **monorepo 內部專用的套件**，不會發布，所以直接 export 原始碼，省掉建置步驟。這種做法常被稱為 internal packages 或 just-in-time packages。

**有一個坑**：Node 原生執行 TypeScript 的功能，**不支援 `node_modules` 底下的 `.ts` 檔**。這裡之所以能運作，是因為 `node_modules/@l10n-review/core` 只是 symlink，Node 會先解析出真實路徑 `packages/core/src/index.ts`，而真實路徑不在 `node_modules` 底下。

這也代表：哪天要把 core **發布到 npm**，就一定要加上建置步驟，因為使用者安裝後，檔案會真的放在 `node_modules` 裡。階段 5 做 CLI 時會碰到這件事。

## 概念 3：套件管理器幫你守住架構邊界

上一階段，「core 不能 import GitHub 的程式碼」只是寫在註解裡的約定，沒有任何機制擋著。

現在 `packages/core/package.json` 沒有宣告 `octokit`，所以在 core 裡寫 `import { Octokit } from "octokit"` 會直接失敗：型別檢查報 `Cannot find module`，執行時報 `ERR_MODULE_NOT_FOUND`。這是 pnpm 嚴格的 `node_modules` 結構帶來的：**每個套件只能使用自己宣告的依賴**。

npm 和 Yarn v1 會把所有依賴「提升」（hoist）到根目錄的 `node_modules`，任何套件都能 import 任何東西，邊界很容易被默默打破。這也是很多團隊選擇 pnpm 的原因之一。

## 概念 4：一次跑完所有套件的檢查

| 指令 | 做什麼 |
|---|---|
| `pnpm typecheck` | `pnpm -r --parallel typecheck`：每個套件各自跑 `tsc` |
| `pnpm test` | Vitest 的 `projects`：一次執行，每個套件是一個 project |
| `pnpm lint` | Biome 在根目錄掃描整個 repo |
| `pnpm --filter @l10n-review/github-app dev` | 只在某個套件裡執行指令 |

CI 的 workflow 完全不用改，因為根目錄的指令名稱都沒變。

## 概念 5：用 `git mv` 搬檔案

搬家時用的是 `git mv`，不是先刪除再新增。這樣 `git log --follow packages/core/src/engine.ts` 還是查得到搬家前的歷史，`git blame` 也不會整個檔案都變成「最近一次修改」。

## 你需要做的事

`.env` 和 `.pem` 的位置變了。從這個 PR 開始，請把它們搬到 `apps/github-app/`：

```bash
mv .env apps/github-app/.env
```

```bash
mv *.pem apps/github-app/
```

兩個檔案都在 `.gitignore` 裡，不會被 commit。`pnpm dev` 照樣在根目錄執行。

## 動手練習

1. 執行 `pnpm why octokit`，看看哪些套件依賴它。再執行 `pnpm --filter @l10n-review/core why octokit`，結果有什麼不同？
2. 試著在 `packages/core/src` 裡 import `hono`，跑 `pnpm typecheck`，觀察錯誤訊息。看完記得改回來。
3. 思考題：`zod` 同時被 core 和 github-app 使用，兩邊各自宣告了依賴。如果兩邊的版本不一樣會發生什麼事？pnpm 怎麼處理？（提示：查一下 `pnpm-lock.yaml`）

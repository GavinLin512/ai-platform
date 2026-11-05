# 階段 5：CLI 與 GitHub Action

到目前為止，要用 l10n-review 就得架一台伺服器、註冊 GitHub App。這一輪把同一個引擎包成另外兩種形式：

- **CLI**：`l10n-review`，在自己的電腦上、push 之前就能檢查
- **GitHub Action**：在別人的 repo 加一個 workflow 檔就能用，不用伺服器、不用資料庫

程式碼在 `packages/cli`，Action 的定義是根目錄的 `action.yml`。

## 這一輪完成了什麼

- `l10n-review` 指令：檢查這個分支改了什麼（已 commit、未 commit、還沒加進 git 的新檔案都算），也能用 `--all` 檢查整個 repo
- 三種輸出：給人看的 text、給工具用的 JSON、給 GitHub Actions 的 annotations
- GitHub Action：問題直接標在 PR 的 **Files changed** 對應的行上，另外在 job summary 列一張表
- 這個 repo 的每個 PR 都會跑自己的 Action（dogfooding）
- CI 檢查 `action/dist` 有沒有跟原始碼同步
- 引擎預設跳過 build 產物和第三方程式碼（`dist/`、`vendor/`、`node_modules/`…）
- 測試：192 → 205 個，其中一組是在暫存資料夾建一個**真的 git repo** 來測

## 實際驗證了什麼

- CLI 在這個 repo 上跑：找到 `examples/` 裡故意放的 10 個問題，也找到 **4 個我們自己的 bug**（見概念 8）
- 打包後的 Action 在本機模擬 GitHub 的環境變數跑過：`fail-on: never` 時 exit 0、預設時 exit 1、輸入打錯時給出清楚的錯誤訊息、job summary 有寫出來
- 連續打包兩次，產出的檔案一模一樣（CI 的同步檢查靠這個）
- ❌ **還沒在 GitHub 上真的跑過**：要等這個 PR 開出來，`l10n-review.yml` 才會第一次執行
- ❌ **還沒發佈到 npm 和 Marketplace**：要用你的帳號（步驟在「動手做」）

---

## 概念 1：同一個引擎，三個入口

```
                    ┌─ GitHub App  ── 讀 GitHub API ──── 發 review 留言
packages/core  ─────┼─ GitHub Action ─ 讀 checkout 的檔案 ─ 印 annotations
（規則，不碰網路）    └─ CLI ──────── 讀 checkout 的檔案 ─ 印到終端機
```

階段 1 把「讀檔案」抽象成 `RepoReader` 介面時，看起來有點多此一舉。現在它的價值出來了：CLI 只寫了一個 30 多行的 `fsReader`（從硬碟讀），規則一行都沒改。

| | GitHub App | GitHub Action | CLI |
|---|---|---|---|
| 結果出現在 | PR 的 review 留言 | annotations + job summary | 終端機 |
| 需要 | 伺服器、安裝 App | 一個 workflow 檔 | Node 22 |
| 歷史紀錄和 dashboard | 有（要 Postgres） | 沒有 | 沒有 |
| push 之前就能檢查 | 不行 | 不行 | 可以 |

Laravel 的類比：同一套 Service class，可以從 Controller、Artisan command、Queue job 三個地方呼叫。

## 概念 2：「這個分支改了什麼」

```bash
git diff --merge-base main --unified=0 --diff-filter=ACMR --find-renames
```

- **`--merge-base`**：跟「分支從 main 分出來的那個點」比，不是跟現在的 main 比。如果你開分支之後 main 又多了別人的 commit，直接 `git diff main` 會把那些也算成你的改動（而且是「刪掉」）。這等於 `git diff main...HEAD`（三個點），但會把還沒 commit 的改動也算進去
- **`--unified=0`**：不要上下文，只要改動的行，方便算出「新增了哪幾行」
- **`--diff-filter=ACMR`**：只要新增（Added）、複製（Copied）、修改（Modified）、改名（Renamed）的檔案，刪掉的檔案不用檢查
- **`git ls-files --others --exclude-standard`**：還沒 `git add` 的新檔案，`git diff` 看不到，要另外列。`.gitignore` 掉的不算
- **`-c core.quotePath=false`**：不然 git 會把 `訂單.tsx` 印成 `"\350\250\202\345\226\256.tsx"`

### 一個只有實際跑才發現的 bug

git 印出的路徑永遠是**相對於 repo 根目錄**，但我們讀檔案是相對於「目前所在的資料夾」。在根目錄跑沒問題，在 `packages/cli` 裡面跑就全錯了，而且不會報錯，只會安靜地說「0 個檔案」。

修法：先用 `git rev-parse --show-toplevel` 找到根目錄，所有事都從那裡做。測試也補了一個「從子資料夾跑，結果要一樣」的案例。

**安靜的錯誤比大聲的錯誤危險**：「No localization issues」看起來就像通過了。

## 概念 3：為什麼要打包（bundle）

workspace 裡的套件一直直接匯出 TypeScript 原始碼，不用 build。但要給**別人**用的東西不一樣：

- **Action**：GitHub 執行 Action 時**不會跑 `npm install`**，只會 checkout 你的 repo，然後 `node action/dist/index.js`。所以所有依賴都必須在那個檔案裡
- **npm 套件**：使用者沒有我們的 workspace，`@l10n-review/core` 也沒發佈到 npm

esbuild 把 `cli.ts` 和它 import 的所有東西（我們的套件、ts-morph、TypeScript 編譯器、Anthropic SDK…）合成一個 JavaScript 檔：

```ts
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,          // 把 import 的東西都放進來
  platform: "node",      // node:fs 這些內建模組不要放
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "eof",  // 第三方套件的授權聲明集中放在檔案最後，不能刪
});
```

檔案大約 10 MB。用 esbuild 的 metafile 看裡面是什麼：TypeScript 編譯器約 6.5 MB（ts-morph 用它來解析 TSX）、OpenCC 的簡繁字典約 2.3 MB，我們自己的程式碼只佔一小部分。打包兩個檔案只要一兩秒，比 webpack 快很多，因為它是 Go 寫的，而且會平行處理。

### ESM 裡的 `require`

第一次打包完執行，馬上出錯：

```
ReferenceError: Cannot determine intended module format because both require()
and top-level await are present.
```

TypeScript 編譯器是很舊的 CommonJS 程式碼，裡面直接用 `require()`、`__filename`、`__dirname`。但我們打包成 ESM，ESM 沒有這些變數，Node 看到兩種寫法混在一起，就不知道該用哪一種規則執行。解法是在檔案最前面自己補上這三個變數：


```js
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

這是 Node 生態系 CJS → ESM 轉換期很常見的問題。PHP 沒有這個包袱：`require`／`include` 從來只有一種。

### 打包之後，`dependencies` 要搬家

本來 `package.json` 把 `@l10n-review/core` 寫在 `dependencies`。如果就這樣發佈，使用者 `npm install` 時 npm 會去找 `@l10n-review/core`，找不到就失敗。但它已經打包在 `dist/cli.js` 裡了，所以要改成 `devDependencies`：**只有開發和打包時需要**。

規則：打包過的套件，`dependencies` 應該是空的（除非某個依賴故意不打包，例如有原生模組的套件）。

## 概念 4：把 build 產物 commit 進 repo

一般來說 `dist/` 不該 commit：它是從原始碼產生的，放進 git 只會造成衝突和「忘了重新 build」。但 Action 是例外，因為 GitHub 不會幫你 build，`uses: owner/repo@v1` 拿到的就是那個 tag 裡的檔案。

代價是**原始碼改了、忘記重新 build**，Action 跑的就是舊版。所以 CI 加了一步：

```yaml
- name: action/dist is up to date
  run: |
    pnpm --filter @l10n-review/cli build
    if [ -n "$(git status --porcelain -- action/dist)" ]; then
      echo "::error::action/dist is stale. ..."
      exit 1
    fi
```

重新打包之後，如果 `git status` 顯示 `action/dist` 有任何變動，就代表 commit 進去的版本是舊的，讓 CI 失敗。這招能成立，前提是**打包結果是確定的**：同樣的原始碼一定產生一模一樣的檔案（沒有時間戳、沒有隨機數）。已經驗證過連續打包兩次結果相同。

### `.gitignore` 的陷阱

這一步一開始寫的是 `git diff --exit-code -- action/dist`，看起來沒問題，而且**永遠通過**。原因是根目錄的 `.gitignore` 有一行 `dist/`，`action/dist` 也被忽略了：

- 檔案根本沒被 commit，Action 在 GitHub 上一跑就會找不到 `action/dist/index.js`
- `git diff` 看不到被忽略的檔案，所以檢查永遠「沒有差異」

修法有兩個：在 `.gitignore` 加一行 `!/action/dist/` 把它排除在忽略之外，並改用 `git status --porcelain`，連「檔案不存在」或「沒被追蹤」也會失敗。

用 `git check-ignore -v <檔案>` 可以查某個檔案是被哪一行規則忽略的。

**寫完一個檢查，要故意讓它失敗一次**，確認它真的會失敗。永遠通過的檢查比沒有檢查更糟，因為它讓人以為有保護。

其他做法：只在發佈的 tag 上放 `dist`（`main` 分支不放），或用 `@vercel/ncc`。這個專案選最簡單的。

## 概念 5：Workflow commands 和 annotations

程式只要在 stdout 印出特定格式的一行，GitHub 就會把它變成 PR 上的標註：

```
::error file=locales/ja.json,line=6,col=5,title=l10n-review: locale-placeholders::{price} 不在原文裡
::warning file=src/Cart.tsx,line=12,col=9,title=l10n-review: no-hardcoded-string::…
```

這就是「workflow commands」，ESLint、TypeScript 等工具的 GitHub 整合都是這樣做的。要注意兩件事：

- **跳脫字元**：訊息裡的換行要寫成 `%0A`、`%` 要寫成 `%25`；`file=`、`title=` 這些屬性裡，`:` 和 `,` 也要跳脫，不然 `title=l10n-review: x` 的 `:` 會被當成分隔符號。測試裡故意用了 `zh-TW,a:b.json` 這種檔名
- **數量上限**：每個 step 最多只顯示 **10 個 error 和 10 個 warning**，整個 job 最多 50 個，多的會被**安靜地丟掉**。所以 job summary（`$GITHUB_STEP_SUMMARY` 指向的 Markdown 檔）會列出全部，超過上限時還會加一行說明

`$GITHUB_STEP_SUMMARY` 是 GitHub 給的一個檔案路徑，寫進去的 Markdown 會顯示在 workflow run 的頁面上。

Action 的輸入也是用環境變數傳：`fail-on` 會變成 `INPUT_FAIL-ON`（轉大寫，`-` 保留）。

## 概念 6：Exit code 是 CI 的介面

CI 只看一件事：程式結束時回傳的數字。

| exit code | 意思 |
|---|---|
| `0` | 通過 |
| `1` | 有 `--fail-on` 等級以上的問題 |
| `2` | 用法錯誤或 git 出錯（例如不在 git repo 裡） |

把「找到問題」和「工具本身壞掉」分成不同的數字，CI 才分得出「程式碼有問題」和「設定有問題」。這是 `grep`、ESLint 的慣例。

`--fail-on` 讓使用者決定多嚴格：剛導入時用 `never`，只看不擋；清乾淨之後改成 `error`。這個 repo 自己用 `never`，因為 `examples/` 裡的問題是故意的。

PHP 的對照：Artisan command 的 `return Command::SUCCESS;`／`Command::FAILURE;`，PHPUnit 測試失敗時也是 exit 1。

## 概念 7：Action 的權限和 fork 的 PR

```yaml
permissions:
  contents: read
```

Action 只讀程式碼、只印 annotations，**不發留言**，所以只需要讀取權限。最小權限原則：萬一某個依賴被植入惡意程式，它能做的事也很有限。

從 fork 開的 PR（開源專案最常見的情況）有兩個限制：

- `GITHUB_TOKEN` 只有讀取權限，不能發留言：這正是 Action 用 annotations 而不是留言的原因之一
- **secrets 不會傳進去**：`anthropic-api-key` 會是空的，所以只跑免費的規則檢查，不會壞掉

## 概念 8：Dogfooding

讓這個 repo 的每個 PR 都跑自己的 Action。這一輪在自己身上用這個工具，找到 4 個問題：

1. **`intl-format` 抓到我們自己的程式碼**：`` `$${cost.toFixed(4)}` `` 這種手動格式化貨幣的寫法，正是這條規則要抓的。改成 `Intl.NumberFormat` 寫的 `formatUsd()`
2. **在子資料夾執行時讀錯檔案**（概念 2）
3. **發佈到 npm 後會裝不起來**（概念 3 最後一段）
4. **檢查了自己的打包檔**：`action/dist` 不再被忽略之後，`intl-format` 開始掃描那個 10 MB 的壓縮檔，回報一堆 TypeScript 編譯器內部的「問題」，執行時間也從 0.7 秒變成 5 秒。任何把 build 產物 commit 進 repo 的專案都會遇到，所以修在引擎裡：`node_modules/`、`vendor/`、`dist/`、`build/`、`.next/`、`*.min.js` 預設一律跳過，GitHub App 也一起受惠

2、3、4 都沒有任何測試會抓到，因為測試只測了「我想到的情況」。**把工具真的拿來用**（在自己身上跑、從別的資料夾跑、準備發佈），是找到這類問題最便宜的方法。

---

## 動手做

### 在本機跑 CLI

```bash
pnpm --filter @l10n-review/cli dev            # 跟 origin/HEAD（或 main）比
pnpm --filter @l10n-review/cli dev --all      # 整個 repo
pnpm --filter @l10n-review/cli dev --format json | jq '.[0]'
```

### 在本機模擬 Action

不用 push 也能試打包好的 Action，只要假裝自己是 GitHub，給它那些環境變數：

```bash
pnpm --filter @l10n-review/cli build
```

```bash
echo '{"pull_request":{"base":{"sha":"'"$(git rev-parse main)"'"}}}' > /tmp/event.json
```

```bash
env GITHUB_ACTIONS=true GITHUB_WORKSPACE=$PWD GITHUB_EVENT_PATH=/tmp/event.json GITHUB_STEP_SUMMARY=/tmp/summary.md "INPUT_FAIL-ON=never" node action/dist/index.js
```

（`INPUT_FAIL-ON` 有 `-`，bash 的 `export` 不接受，所以要用 `env`。）

### 發佈到 npm

1. 在 <https://www.npmjs.com> 註冊帳號，開啟兩步驟驗證
2. `@l10n-review/` 是一個 scope，要先建立同名的 **organization**（npmjs.com → Add Organization → `l10n-review`，免費方案只能放公開套件）。如果名字被拿走了，就把 `packages/cli/package.json` 的 `name` 改成 `@你的帳號/l10n-review`
3. 決定授權方式，在 repo 根目錄加 `LICENSE` 檔、在 `package.json` 加 `"license"`。這是你的決定，所以我沒有幫你選
4. 第一次手動發佈：
   ```bash
   npm login
   ```
   ```bash
   pnpm --filter @l10n-review/cli publish
   ```
   用 `pnpm publish` 而不是 `npm publish`：pnpm 會把 `workspace:*` 換成真的版本號。`prepublishOnly` 會先自動打包。pnpm 預設只允許在 `main` 分支、沒有未 commit 的改動時發佈
5. 之後改成從 GitHub Actions 發佈（**trusted publishing**）：在 npmjs.com 的套件設定 → Trusted Publisher 填入這個 repo 和 workflow 檔名，workflow 給 `id-token: write` 權限。這樣就**不用在 GitHub 存 npm token**，npm 還會自動附上 provenance（證明這個版本是從哪個 commit、哪次 CI 建出來的）。npm CLI 需要 11.5.1 以上。套件要先存在才能設定，所以第 4 步的第一次發佈還是要手動

試試看：`npx @l10n-review/cli --help`

### 讓別人用你的 Action

repo 是公開的話，**不用上架 Marketplace 也能用**：

```yaml
- uses: GavinLin512/ai-platform@v1
```

發一個版本：

```bash
git tag -a v1.0.0 -m "l10n-review v1.0.0"
```

```bash
git tag -f v1
```

```bash
git push origin v1.0.0 v1 --force
```

慣例是同時有完整版本（`v1.0.0`，不再移動）和主版本（`v1`，每次發新的 1.x 就移過去）。使用者寫 `@v1` 就會自動拿到修正，又不會突然遇到不相容的 v2。要更安全的話，用 commit SHA：`@<40 個字元的 SHA>`。

**上架 Marketplace** 有額外要求：repo 要公開、根目錄只能有一個 `action.yml`，而 GitHub 文件還寫著 repo **不能有 workflow 檔**。這個 monorepo 有 `ci.yml`、`deliver.yml`，不符合。常見做法是另開一個只放 `action.yml` 和 `action/dist` 的 repo（例如 `l10n-review-action`），由這邊的 release workflow 自動同步過去。

## Laravel 對照表

| 這一輪 | Laravel／PHP |
|---|---|
| `l10n-review` CLI | 一個 Artisan command，或 `vendor/bin/phpstan` |
| `bin` 欄位 | `composer.json` 的 `bin` |
| esbuild 打包成單一檔案 | 把工具打包成 `.phar`（例如 `composer.phar`、`php-cs-fixer.phar`） |
| `devDependencies` | `require-dev` |
| npm 發佈 | Packagist（Packagist 直接讀 git tag，不用上傳） |
| exit code | `Command::SUCCESS`／`Command::FAILURE` |
| annotations | PHPStan 的 `--error-format=github` |

`--error-format=github` 是個好例子：PHPStan、Psalm 都支援直接輸出 GitHub annotations，跟我們的 `--format github` 是同一件事。

## 動手練習

1. **`--format sarif`**：SARIF 是靜態分析的標準格式，上傳到 GitHub 之後問題會出現在 **Security → Code scanning**，而且**沒有 10 個的上限**（公開 repo 免費）。在 `format.ts` 加一個 `formatSarif()`，再用 `github/codeql-action/upload-sarif` 上傳。（提示：每個 finding 是 `results` 陣列的一項，`ruleId`、`level`、`locations[0].physicalLocation`）
2. **pre-commit hook**：CLI 加一個 `--staged` 選項，只檢查 `git add` 過的內容（`git diff --cached`）。然後用 husky 或 lefthook 在 commit 前自動跑。為什麼這裡要讀 staged 的版本，而不是硬碟上的檔案？
3. **release workflow**：寫一個 `.github/workflows/release.yml`：push `cli-v*` tag 時，跑測試、`pnpm --filter @l10n-review/cli publish`（trusted publishing）。需要哪些 `permissions`？
4. **思考題**：Action 現在每次都把 TypeScript 編譯器（約 6.5 MB）和 OpenCC 字典（約 2.3 MB）一起載入。如果一個 PR 只改了 `locales/ja.json`，兩個都用不到。要怎麼做到「用到才載入」？（提示：dynamic `import()`，esbuild 的 `splitting`）

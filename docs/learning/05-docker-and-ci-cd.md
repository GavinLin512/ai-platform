# 階段 3：佇列、Docker、CI/CD 與 Cloud Run

這一輪讓 bot 從「跑在你電腦上、靠 smee 轉發」變成「可以部署到雲端、不怕重啟」的服務。

## 這一輪完成了什麼

- `packages/db`：Drizzle ORM、migration、記錄每次 review 和每個問題
- **Postgres 工作佇列**（pg-boss）：webhook 只負責排隊，worker 負責 review，失敗會自動重試
- 結構化 JSON log（Cloud Logging 格式）、graceful shutdown、`/healthz` 與 `/readyz`
- Dockerfile（multi-stage、非 root 使用者）與 `docker-compose.yml`
- CI：Postgres service container 跑整合測試、每個 PR 都 build 一次 image
- CD：push 到 main → 推 image 到 GHCR → 部署到 Cloud Run（設定好 GCP 後才會啟用）
- 測試：128 → 145 個（其中 5 個需要 Postgres，沒有 `DATABASE_URL` 時會略過）

## 現在的架構

```
GitHub ──webhook──▶ /api/github/webhooks
                     │ 驗證簽章，把「review 這個 commit」寫進佇列（幾毫秒）
                     │ 回 202
                     ▼
              Postgres（pg-boss 佇列）
                     │
                     ▼
                  worker ──▶ 換 installation token ──▶ 讀 PR、跑規則、留言
                     │
                     ▼
              Postgres（reviews、findings 表）──▶ 之後的 Dashboard
```

沒有設定 `DATABASE_URL` 時，會退回原本的「同一個行程裡背景執行」，所以本機開發照樣不需要資料庫。

---

## 概念 1：為什麼一定要有佇列

階段 1 的筆記提過，原本的做法有兩個缺點：行程重啟時，正在跑的 review 會遺失；Cloud Run 在回應送出後會限制 CPU。

佇列把「收到請求」和「做事」拆開：

| | 沒有佇列 | 有 Postgres 佇列 |
|---|---|---|
| 部署或當機時正在跑的 review | 遺失 | 留在資料庫裡，重啟後由 worker 接手 |
| GitHub API 暫時出錯 | 失敗就沒了 | 30 秒、60 秒、120 秒……指數退避重試 |
| 同一個 webhook 被送兩次 | 跑兩次 | 去重（見概念 3） |
| 開兩個 instance | 各跑各的 | 共用同一個佇列，分攤工作 |

Laravel 對照：`ReviewPullRequest::dispatch()` 搭配 `php artisan queue:work`，driver 用 `database`。pg-boss 幾乎就是 Node 版的 database queue driver。

### 為什麼用 Postgres，不用 Redis

Redis（例如 BullMQ）更快，但需要多維護一個服務。這個專案本來就要有 Postgres（review 紀錄、之後的翻譯記憶），一個 review 動輒幾秒，佇列每秒處理幾千筆的效能根本用不到。**少一個元件，就少一個會壞的地方。**

## 概念 2：重試代表「至少執行一次」，所以工作必須冪等

佇列保證的是「至少執行一次」（at-least-once），不是「剛好一次」：worker 可能在留言完成、但還沒回報成功之前當掉，這個工作就會被重新執行。

所以 review 必須**冪等**（idempotent）：同一件事做兩次，結果跟做一次一樣。階段 1 做的 fingerprint 去重，現在多了一個重要的理由：重試時，已經留過的言不會再留一次。

## 概念 3：實際驗證才抓到的 bug，pg-boss 的 queue policy

我原本在程式碼註解裡寫「同一個 commit 用相同的 `singletonKey`，重送的 webhook 不會被排兩次」。單元測試沒有問題，但在 Docker 裡用真的 Postgres 跑時，同一個 webhook 送兩次，佇列裡**出現了兩個工作**。

去讀 pg-boss 的原始碼才發現，`singletonKey` 本身不會去重，要看 queue 的 policy 建了什麼 unique index：

| policy | unique 條件 | 效果 |
|---|---|---|
| `standard`（預設） | 沒有 | **完全不去重** |
| `short` | 只限 `created` 狀態 | 排隊中的不重複，但執行中可能重複 |
| `singleton` | 只限 `active` 狀態 | 同時只有一個在執行 |
| `stately` | 每個狀態各自唯一 | 排隊中最多一個、執行中最多一個 |

選 `stately` 的原因：worker 並行數是 2，如果同一個 commit 有兩個工作**同時**在跑，兩邊都還沒留言時會各自判斷「這則還沒留過」，結果**同一則留言被留兩次**，fingerprint 去重也擋不住這種競態（race condition）。

修正後補了一個整合測試，也做了突變測試：把 `policy: "stately"` 拿掉，那個測試就會失敗。

**教訓**：註解寫的是你「以為」的行為。跟外部系統（資料庫、佇列、API）有關的假設，要用真的系統驗證過才算數。

## 概念 4：Drizzle 與 migration

`packages/db/src/schema.ts` 用 TypeScript 定義資料表，`pnpm --filter @l10n-review/db db:generate` 會比對 schema 的變化，產生 SQL migration 檔（`packages/db/drizzle/0000_init.sql`）。

| Drizzle | Laravel |
|---|---|
| `schema.ts` | migration + Eloquent model 的欄位定義 |
| `drizzle-kit generate` | `php artisan make:migration`，但會自動算出差異 |
| `migrateDatabase()` | `php artisan migrate` |
| `casing: "snake_case"` | Eloquent 預設的 snake_case 欄位名稱 |

### 多個 instance 同時啟動時，誰來跑 migration？

滾動更新時，新舊 instance 可能同時啟動、同時跑 migration，結果互相衝突。`migrateDatabase()` 先取得 Postgres 的 **advisory lock**，其他 instance 會排隊等它跑完。整合測試就是故意同時跑兩次 migration 來驗證這件事。

一個細節：advisory lock 屬於**取得它的那條連線**。連線池裡的下一個查詢可能用的是另一條連線，在那條連線上解鎖會失敗。所以程式用 `sql.reserve()` 保留一條專用連線，鎖和解鎖都在同一條連線上做。

## 概念 5：Dockerfile 的幾個重點

`apps/github-app/Dockerfile`：

1. **Multi-stage**：第一階段安裝依賴，第二階段只複製需要的東西。最終 image 裡沒有 pnpm 的快取
2. **先複製 `package.json`，再複製原始碼**：Docker 會快取每一層。只改程式碼時，最慢的「安裝依賴」那一層可以直接重用
3. **`--prod`**：不安裝 Vitest、Biome、TypeScript 這些開發工具
4. **非 root 使用者**（`USER node`）：容器被攻破時，攻擊者拿到的權限比較小
5. **金鑰不進 image**：`.dockerignore` 排除 `.env` 和 `*.pem`。金鑰在執行時才透過環境變數或掛載的檔案傳入

一個 monorepo 特有的細節：Docker 的 `COPY` 會**保留 symlink**，所以 image 裡的 `node_modules/@l10n-review/core` 仍然指向 `packages/core`，Node 照樣能直接執行 TypeScript。

### docker compose

`docker-compose.yml` 在本機重現正式環境：Postgres 加上 App 的容器。幾個值得注意的地方：

- `depends_on.condition: service_healthy`：等 Postgres 的 healthcheck 通過才啟動 App
- `secrets:`：private key 以檔案形式掛在 `/run/secrets/`，不會出現在環境變數或 image 裡
- `profiles: [smee]`：smee 是選用服務，`docker compose --profile smee up` 才會啟動

**Laravel 對照**：Laravel Sail 本質上就是一份 `docker-compose.yml`。

## 概念 6：Health 與 Readiness 不一樣

| 端點 | 問的是 | 失敗時平台會 |
|---|---|---|
| `/healthz`（liveness） | 程序還活著嗎？ | **重啟**容器 |
| `/readyz`（readiness） | 現在能處理請求嗎？（例如資料庫連得上） | **暫停送流量**，不重啟 |

資料庫暫時斷線時，重啟 App 也沒用，所以 `/readyz` 失敗不應該觸發重啟，只要讓流量先別進來。

## 概念 7：Graceful shutdown

部署新版本時，平台會先送 `SIGTERM`，等一段時間之後才強制關閉（Cloud Run 是 10 秒，K8s 預設 30 秒）。`src/index.ts` 收到 `SIGTERM` 時會：

1. 停止接受新的 HTTP 請求
2. 讓正在跑的 review 跑完，最多等 `SHUTDOWN_TIMEOUT_MS`
3. 關閉資料庫連線，然後結束程序

在 Docker 裡實測：收到 `SIGTERM` 後，20 毫秒內完成 `shutting down` → `bye`。

## 概念 8：結構化 log

每一行 log 都是一個 JSON 物件：

```json
{"severity":"INFO","time":"…","delivery":"d1","pr":"acme/shop#7","queue":"postgres","message":"review queued"}
```

好處是可以**用欄位查詢**，例如在 Cloud Logging 裡查「`pr` 是 `acme/shop#7` 的所有 log」，或用 `kubectl logs … | jq 'select(.severity=="ERROR")'`。欄位名稱用 `severity` 和 `message`，因為這是 Google Cloud 能自動辨識的格式。本機開發時設 `LOG_FORMAT=pretty`，會輸出人看得懂的彩色格式。

## 概念 9：CI 與 CD

**CI**（`.github/workflows/ci.yml`）每個 PR 都會跑：

- `check`：lint、型別檢查、測試。用 **service container** 跑一個真的 Postgres，整合測試才有資料庫可用
- `docker`：build image 但不推送。Dockerfile 壞掉的話，在 PR 階段就會被發現

**CD**（`.github/workflows/deliver.yml`）在 push 到 main 時跑：

1. **`image`**：build 並推到 GitHub Container Registry（GHCR）。用 workflow 內建的 `GITHUB_TOKEN`，不需要另外的帳號。每個 commit 一個**不會變的 tag**（`sha-abc1234`），部署時用的就是它，要回滾到哪個版本都很明確
2. **`deploy-cloud-run`**：只有在設定了 `GCP_PROJECT_ID` 這個 repository variable 之後才會執行；還沒設定時是**略過**，不是失敗

### Workload Identity Federation：不用金鑰的雲端登入

傳統做法是在 GCP 產生一個 service account 金鑰（JSON 檔），放進 GitHub Secrets。這把金鑰長期有效，外洩就麻煩了。

Workload Identity Federation 的做法是：GitHub Actions 每次執行時都會拿到一個短期的 OIDC token，證明「我是 `GavinLin512/ai-platform` 這個 repo 的 workflow」。GCP 驗證這個 token 之後，發一組短期憑證給它。**整個過程沒有任何長期金鑰**，workflow 裡的 `id-token: write` 權限就是用來拿那個 OIDC token 的。

### 為什麼要 `--no-cpu-throttling`

Cloud Run 預設只在**處理請求的期間**分配 CPU。webhook 回了 202 之後，worker 還要繼續 review，所以要用 `--no-cpu-throttling`，讓 instance 存活期間 CPU 都可用。

**取捨**：`--min-instances=0` 時，沒有流量的 instance 會被關掉。排定在 60 秒後的重試，如果那時剛好沒有 instance，就要等下一個 webhook 喚醒服務才會執行。對 PR bot 來說可以接受，因為下一次 push 就會觸發。如果不能接受，可以改成 `--min-instances=1`，但那會持續計費。

---

## 動手做：部署到 Cloud Run

在本機執行，需要先安裝 `gcloud` CLI 並登入（`gcloud auth login`）。

**0. 先準備一個 Postgres。** 最省事的是 [Neon](https://neon.tech) 的免費方案：建立專案後複製連線字串，結尾要有 `?sslmode=require`。不想多一個帳號的話，可以用 Cloud SQL，但它是付費服務。

**1. 設定變數**

```bash
PROJECT_ID=l10n-review-$RANDOM
REGION=asia-east1
REPO=GavinLin512/ai-platform
```

**2. 建立專案、連結帳單、啟用 API**

```bash
gcloud projects create "$PROJECT_ID"
```

到 Cloud Console 的 Billing 頁面，把帳單帳戶連結到這個專案，然後：

```bash
gcloud config set project "$PROJECT_ID"
```

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
```

**3. 建立 image 倉庫**

```bash
gcloud artifacts repositories create l10n-review --repository-format=docker --location="$REGION"
```

**4. 建立兩個 service account**：一個給 GitHub Actions 部署用，一個給 Cloud Run 執行時用（最小權限原則）

```bash
gcloud iam service-accounts create l10n-deployer
```

```bash
gcloud iam service-accounts create l10n-runtime
```

```bash
DEPLOYER="l10n-deployer@$PROJECT_ID.iam.gserviceaccount.com"
RUNTIME="l10n-runtime@$PROJECT_ID.iam.gserviceaccount.com"
```

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOYER" --role=roles/run.admin
```

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOYER" --role=roles/artifactregistry.writer
```

```bash
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser
```

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME" --role=roles/secretmanager.secretAccessor
```

**5. 讓 GitHub Actions 不用金鑰就能登入（Workload Identity Federation）**

```bash
gcloud iam workload-identity-pools create github --location=global
```

```bash
gcloud iam workload-identity-pools providers create-oidc github-actions --location=global --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" --attribute-condition="assertion.repository=='$REPO'"
```

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
```

```bash
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

`--attribute-condition` 限定**只有這個 repo** 的 workflow 能登入，其他 repo 就算知道設定也進不來。

**6. 把金鑰放進 Secret Manager**

```bash
gcloud secrets create github-app-private-key --data-file=path/to/your-app.private-key.pem
```

```bash
printf '%s' 'your-webhook-secret' | gcloud secrets create github-webhook-secret --data-file=-
```

```bash
printf '%s' 'postgres://…?sslmode=require' | gcloud secrets create database-url --data-file=-
```

**7. 在 GitHub 設定 repository variables**

Repository → **Settings** → **Secrets and variables** → **Actions** → **Variables** 分頁，新增：

| 名稱 | 值 |
|---|---|
| `GCP_PROJECT_ID` | 第 1 步的 `$PROJECT_ID` |
| `GCP_REGION` | `asia-east1` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github-actions` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `$DEPLOYER` 的值 |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `$RUNTIME` 的值 |
| `L10N_GITHUB_APP_ID` | 你的 App ID |

這些都不是機密，所以放在 variables，不是 secrets。App ID 的變數名稱不能用 `GITHUB_` 開頭，因為那是 GitHub 保留的前綴（`actionlint` 抓到的）。

**8. 部署**：merge 到 main，或在 Actions 分頁手動執行 **Deliver**。完成後，把 GitHub App 的 Webhook URL 改成：

```
https://<Cloud Run 給的網址>/api/github/webhooks
```

到這一步，就不再需要 smee 和你的電腦了。

---

## 這一輪實際驗證時發現的問題

| 問題 | 怎麼發現的 | 如果沒發現會怎樣 |
|---|---|---|
| pg-boss 預設不去重 | 在 Docker 裡同一個 webhook 送兩次 | 同一則留言可能出現兩次 |
| `beforeEach(() => mock.mockReset())` | 測試莫名失敗 | Vitest 把回傳的 mock 當成清理函式執行（見下方） |
| repository variable 不能用 `GITHUB_` 開頭 | `actionlint` | 在設定頁建不出這個變數，部署時 App ID 是空的 |
| compose 的 `${SMEE_URL:?}` | `docker compose config` | 沒用到 smee 時，`docker compose up` 也會失敗 |

**Vitest 的坑**：`beforeEach(() => vi.mocked(fn).mockReset())` 這個箭頭函式會回傳 `mockReset()` 的結果，也就是 mock 本身。**Vitest 會把 `beforeEach` 回傳的函式當成測試結束後的清理函式來執行**，所以那個 mock 會在測試後被呼叫一次。加上大括號 `() => { … }` 就不會回傳任何值。

## Laravel 對照表

| 這一輪 | Laravel |
|---|---|
| pg-boss + worker | `dispatch()` + `queue:work`（database driver） |
| `retryLimit` / `retryBackoff` | Job 的 `$tries` / `$backoff` |
| `stately` policy | `ShouldBeUnique` + `WithoutOverlapping` middleware |
| Drizzle migration | `php artisan migrate` |
| `docker-compose.yml` | Laravel Sail |
| `/healthz` | Laravel 11 起內建的 `/up` |
| Cloud Run + GitHub Actions | Laravel Vapor／Forge 的自動部署 |
| Secret Manager | Forge 或 Vapor 的環境變數加密存放 |

## 動手練習

1. **看佇列運作**：`docker compose up db`，在 `.env` 設定 `DATABASE_URL`，`pnpm dev`，送一個 webhook。然後用 `docker compose exec db psql -U l10n -d l10n` 查 `select name, state, retry_count from pgboss.job;`，觀察工作的狀態變化。
2. **新增欄位**：在 `reviews` 表加一個 `duration_ms` 欄位，用 `pnpm --filter @l10n-review/db db:generate` 產生 migration，看看產生出來的 SQL。worker 要怎麼算出這個值？
3. **體驗 graceful shutdown**：在 worker 裡暫時加一個 `await new Promise((r) => setTimeout(r, 5000))`，送一個 webhook 之後立刻按 Ctrl+C，觀察程式會等那個 review 跑完才結束。
4. **思考題**：概念 9 提到 `--min-instances=0` 時，重試可能要等下一個 webhook 才會執行。除了改成 `min-instances=1`，還有什麼更省錢的做法？（提示：Cloud Scheduler）

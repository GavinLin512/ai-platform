# l10n-review

A GitHub App that reviews pull requests for **localization problems**, with a focus on Asian
languages (Traditional Chinese, Japanese, Korean, Thai, Vietnamese).

> Working name. Status: **Phase 1** — deterministic rules only, no LLM yet.

```
PR opened / pushed
  → webhook (signature verified)
  → fetch changed files + diff
  → rules engine (AST, zero tokens)          ← you are here
  → [Phase 2] SQL/vector retrieval + LLM context checks + verifier
  → one review with inline comments
```

## What it checks today

| Rule | Catches |
|---|---|
| `no-hardcoded-string` | User-facing text written directly in JSX/TSX instead of going through i18n: JSX text, `alt` / `aria-label` / `label` / `placeholder` / `title`, and simple expressions like `{soldOut ? "Sold out" : "In stock"}` |
| `locale-keys` | A key added to the source locale (`en` by default) that other locales lack, and a key in a translation that the source does not have (with a "did you mean" for typos). Plural forms a language does not have are not required: `item_one` missing from `ja.json` is correct, because Japanese, Chinese, Korean, Thai and Vietnamese only have `other` |
| `locale-placeholders` | Translations whose placeholders differ from the source: `"滿 {price} 免運"` against `"Free shipping over {amount}"`, broken ICU syntax, `{name}` in an i18next project. Understands ICU MessageFormat (including `plural` / `select`) and i18next `{{name}}`. When the source changes, also flags translations that were left behind |
| `intl-format` | Numbers, dates and money formatted by hand or without a locale: `toLocaleDateString()` / `new Intl.NumberFormat()` without a locale (the server's locale during SSR), dates assembled from `getFullYear()`/`getMonth()`, `toFixed()` in JSX, and currency symbols like `NT$` written next to a number. Dates and money differ a lot across Asia: `2026/11/4` (zh-TW), `2026. 11. 4.` (ko-KR), `4/11/2569` (th-TH, Buddhist era), `￥1,235` (no decimals), `1.235 ₫` (symbol after the number) |
| `zh-tw-terminology` (LLM) | Mainland Chinese wording in Taiwan Traditional Chinese strings, judged in context: 軟件 → 軟體, 結算 → 結帳 (checkout), 包郵 → 免運, but 「感謝您的支持」 and 文件 meaning "document" are left alone. A free dictionary pre-screen (OpenCC + an e-commerce supplement) picks what to send, the model judges, a second pass verifies |
| `translation-meaning` (LLM) | Translations that change, drop or add meaning ("Cancel order" → 確認訂單), or whose tone clashes with the rest of the product (你 among 您), using similar strings from the same locale as style examples |

The LLM checks run only when `ANTHROPIC_API_KEY` is set, only on lines the PR added, and a
failed call skips that check instead of failing the review. Every call's tokens and cost are
recorded (`llm_usage` table). The eval set in `packages/ai/eval` measures them: the dictionary
alone reaches 100% recall at 80.6% precision, and its six false positives are exactly the
context-dependent words the model has to resolve (`pnpm --filter @l10n-review/ai eval`).

Locale files are recognised by path: a `.json` file named after a locale (or inside a directory
named after one) somewhere under `locales/`, `lang/`, `i18n/`, `messages/`, `translations/`…
For example `locales/zh-TW.json`, `lang/ja.json` (Laravel), `public/locales/ko/common.json`
(i18next). Whether a name is a locale is decided by the CLDR data built into Node
(`Intl.DisplayNames`), so `zh_TW`, `pt-BR` or `id` work without a hand-kept list.

Design choices:

- **Only lines added in the PR are reviewed.** Legacy code is not the author's problem in this PR.
- **Precision over recall.** Comparisons, `className`, object keys, `<Trans>`, `<code>`, tests and
  stories are ignored. A noisy reviewer gets uninstalled.
- **Idempotent.** Each comment carries a hidden fingerprint (rule + file + text, not line), so
  pushing more commits never duplicates a comment.

## Configuration

Optional. Put a `.l10nrc.yml` at the repository root (it is read from the commit under review):

```yaml
sourceLocale: zh-TW            # the locale translators translate from (default: en)
localeDirs: [locales, lang]    # directories that contain locale files (default: a built-in list)
ignore: ["legacy/**"]          # paths no rule looks at
rules:
  locale-keys: false           # turn a rule off
  no-hardcoded-string:         # or configure it
    attributes: [alt, title, placeholder, aria-label, tooltip]
    ignoreElements: [Trans, code, Brand]
  translation-meaning: false   # LLM checks can be turned off one by one too
ai:                            # used when ANTHROPIC_API_KEY is set
  model: claude-opus-5-5       # default
  effort: medium               # low | medium | high | xhigh | max
  verify: true                 # second pass that re-checks each finding before posting
```

Unknown settings are errors, so a typo is reported instead of silently doing nothing. A broken configuration
is reported on its line when a PR changes it, and the defaults are used until it is fixed.

## Project layout

A pnpm monorepo. Each workspace declares its own dependencies, so a package cannot import
something it did not ask for: `packages/core` has no way to reach `octokit`.

```
packages/
  core/            @l10n-review/core: platform-agnostic rules engine (no GitHub, no network)
    src/rules/     One file per rule.
    src/locale/    Locale file detection, JSON with positions, placeholders, plural forms.
    src/config.ts  .l10nrc.yml loading and validation.
    src/analyze.ts The entry point every integration uses.
  db/              @l10n-review/db: Postgres schema (Drizzle), migrations, review history
apps/
  github-app/      @l10n-review/github-app: webhook server, job queue + worker, dry-run script
deploy/k8s/        Kubernetes manifests (kustomize base + a kind overlay for local practice)
examples/          Demo files with deliberate issues, for end-to-end tries.
docs/learning/     Notes on the concepts behind each phase (zh-TW).
```

Workspace packages export their TypeScript source directly (`"exports": "./src/index.ts"`), so
there is still no build step: pnpm links `node_modules/@l10n-review/core` to `packages/core`,
and Node runs the real file, which is outside `node_modules`.

## Requirements

- Node.js ≥ 22.18 (runs TypeScript directly via type stripping, no build step). CI uses Node 24.
- pnpm 10 (`npm install -g pnpm@10`; the exact version is pinned in `package.json`).

## Commands

```bash
pnpm install
pnpm test        # Vitest
pnpm typecheck   # tsc (type-check only, nothing is emitted)
pnpm lint        # Biome (lint + format check); `pnpm format` fixes
pnpm dev         # start the GitHub App with --watch, reading apps/github-app/.env
pnpm review:dry-run <PR URL>   # run the review on a real PR, print instead of post
```

## Running it

| Setup | Database | Use it for |
|---|---|---|
| `pnpm dev` | none: reviews run in-process | developing rules |
| `pnpm dev` + `DATABASE_URL` | `docker compose up db` | developing the queue / history |
| `docker compose up --build` | in Compose | the production setup on your machine |
| Cloud Run (`.github/workflows/deliver.yml`) | Neon / Cloud SQL | production |
| Kubernetes (`deploy/k8s`) | in-cluster (kind) | learning Kubernetes |

With `DATABASE_URL` set, webhooks only enqueue a job (pg-boss on Postgres) and answer `202`;
a worker does the review with retries and exponential backoff, and every run is recorded in
the `reviews` and `findings` tables. Logs are JSON in Google Cloud's format (`LOG_FORMAT=pretty`
for a terminal). `GET /healthz` is liveness, `GET /readyz` checks the database.

Deployment walkthroughs (zh-TW): [Docker, CI/CD and Cloud Run](docs/learning/05-docker-and-ci-cd.md),
[Kubernetes with kind](docs/learning/06-kubernetes.md).

## Try it on a real pull request

### Option A: dry run (2 minutes, no App needed)

Runs the real review flow against any PR you can read (real diff, real file contents, real
de-duplication) and prints the review instead of posting it:

```bash
GITHUB_TOKEN=<token that can read the repo> pnpm review:dry-run https://github.com/OWNER/REPO/pull/123
```

Public repositories work without a token (GitHub's anonymous rate limit applies).

### Option B: the full GitHub App (about 10 minutes)

1. **Create a webhook proxy** so GitHub can reach your laptop: open <https://smee.io/new> and
   keep the page open; copy the channel URL.
2. **Register the App** with this pre-filled link (permissions and events are already selected):
   [Register l10n-review-dev](https://github.com/settings/apps/new?name=l10n-review-dev&description=Localization%20review%20bot%20(development)&url=https%3A%2F%2Fgithub.com%2FGavinLin512%2Fai-platform&public=false&webhook_active=true&pull_requests=write&contents=read&metadata=read&events%5B%5D=pull_request)
   - Paste the smee.io URL into **Webhook URL**
   - Type a **Webhook secret** (`openssl rand -hex 32`). GitHub does not allow pre-filling it
   - App names are global: if `l10n-review-dev` is taken, add a suffix
   - It asks for Pull requests: Read and write, Contents: Read-only, Metadata: Read-only, and
     subscribes to the **Pull request** event
3. After creating it, note the **App ID**, click **Generate a private key**, and move the
   downloaded `.pem` into `apps/github-app/` (`*.pem` is gitignored).
4. **Install the App**: left sidebar → Install App → Only select repositories → your test repo.
5. **Configure and start**:
   ```bash
   cp apps/github-app/.env.example apps/github-app/.env   # set GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET
   pnpm dev
   ```
6. **Forward webhooks** in another terminal:
   ```bash
   pnpm dlx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/api/github/webhooks
   ```
7. **Open a PR** that adds or changes a `.tsx` file. [`examples/ProductCard.tsx`](examples/ProductCard.tsx)
   exists for this: a PR that adds it should get one review with 3 comments
   (`商品圖片`, `已售完`, `加入購物車`). The `pnpm dev` terminal logs `review completed`.
   [`examples/locales/`](examples/locales) does the same for the locale rules: 3 more comments
   (`cart.checkout` missing from `ja`, the `cart.chekout` typo, `{price}` instead of `{amount}`),
   and [`examples/OrderSummary.tsx`](examples/OrderSummary.tsx) for `intl-format` (4 comments).
8. **Push another commit** to the same PR. Already-reported strings are not commented on again;
   the log shows them under `alreadyReported`.

**Troubleshooting**

| Symptom | Likely cause |
|---|---|
| **Recent Deliveries** (App settings → Advanced) is empty | The webhook is not **Active** (General → Webhook), the **Pull request** event is not subscribed (Permissions & events → Subscribe to events), or the App is not installed on the repository. Installing the App always sends an `installation` event, so an empty list right after installing means the webhook is off |
| Deliveries show on GitHub, but smee-client prints nothing | smee-client is listening on a different channel than the App's Webhook URL. Open the channel URL in a browser: the smee page lists every event it receives |
| `400 Missing GitHub webhook headers` | The App has no webhook secret, so GitHub sends no signature |
| `401 Invalid signature` | `GITHUB_WEBHOOK_SECRET` differs from the secret saved in the App |
| `Resource not accessible by integration` | A permission is missing, or you changed permissions and have not accepted them in the installation settings yet |
| `review completed` with `findings: 0` | The file is not `.tsx`/`.jsx`, or the strings are not on lines added by the PR |
| PR was opened before the server started | Redeliver the event from Recent Deliveries, or push a commit (`synchronize`) |
| PR was opened before the App was installed, or while the webhook was off | Nothing was delivered, so there is nothing to redeliver: close and reopen the PR, or push a commit |

## Roadmap

1. **Rules layer** — hardcoded strings ✅, locale keys ✅, placeholder mismatch ✅, `Intl`
   formatting ✅, `.l10nrc.yml` config ✅
2. **LLM layer** — Taiwan vs. mainland usage in context ✅, meaning and tone ✅, cost tracking ✅,
   eval set ✅; next: glossary enforcement, measuring the LLM mode with a real API key
3. **Deploy** — Docker ✅, job queue ✅, CI/CD ✅, Cloud Run ✅ (needs your GCP project), Kubernetes ✅
4. **Dashboard** — Next.js: findings over time, acceptance rate, token cost
5. **Distribution** — CLI and GitHub Action built on `src/core`

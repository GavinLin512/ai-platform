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

Design choices:

- **Only lines added in the PR are reviewed.** Legacy code is not the author's problem in this PR.
- **Precision over recall.** Comparisons, `className`, object keys, `<Trans>`, `<code>`, tests and
  stories are ignored. A noisy reviewer gets uninstalled.
- **Idempotent.** Each comment carries a hidden fingerprint (rule + file + text, not line), so
  pushing more commits never duplicates a comment.

## Project layout

```
src/
  core/          Platform-agnostic: diff parsing, rules, engine. Never imports from github/.
    rules/       One file per rule.
  github/        GitHub App: webhook handlers, PR review flow, comment formatting.
  server.ts      Hono HTTP server (webhook endpoint + health check).
  env.ts         Environment validation (zod).
  index.ts       Entry point.
test/            Vitest, mirrors src/.
scripts/         Developer tools (dry-run).
examples/        A demo component with deliberate issues, for end-to-end tries.
docs/learning/   Notes on the concepts behind each phase (zh-TW).
```

`src/core` is kept free of GitHub code so that the same engine can later power a CLI and a
GitHub Action.

## Requirements

- Node.js ≥ 22.18 (runs TypeScript directly via type stripping, no build step). CI uses Node 24.
- pnpm 10 (`npm install -g pnpm@10`; the exact version is pinned in `package.json`).

## Commands

```bash
pnpm install
pnpm test        # Vitest
pnpm typecheck   # tsc (type-check only, nothing is emitted)
pnpm lint        # Biome (lint + format check); `pnpm format` fixes
pnpm dev         # start the server with --watch, reading .env
pnpm review:dry-run <PR URL>   # run the review on a real PR, print instead of post
```

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
   downloaded `.pem` into the project root (`*.pem` is gitignored).
4. **Install the App**: left sidebar → Install App → Only select repositories → your test repo.
5. **Configure and start**:
   ```bash
   cp .env.example .env   # set GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET
   pnpm dev
   ```
6. **Forward webhooks** in another terminal:
   ```bash
   pnpm dlx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/api/github/webhooks
   ```
7. **Open a PR** that adds or changes a `.tsx` file. [`examples/ProductCard.tsx`](examples/ProductCard.tsx)
   exists for this: a PR that adds it should get one review with 3 comments
   (`商品圖片`, `已售完`, `加入購物車`). The `pnpm dev` terminal logs `review completed`.
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

1. **Rules layer** — hardcoded strings ✅, missing locale keys, placeholder mismatch
   (`{count}` missing in `ja.json`), raw number/date formatting instead of `Intl`, `.l10nrc.yml`
   config
2. **LLM layer** — Taiwan vs. mainland usage in context, meaning drift, tone consistency,
   glossary enforcement; SQL-join retrieval over terms/keys + pgvector translation memory;
   eval set
3. **Deploy** — Docker, GitHub Actions, Cloud Run, job queue
4. **Dashboard** — Next.js: findings over time, acceptance rate, token cost
5. **Distribution** — CLI and GitHub Action built on `src/core`

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
```

## Running it against a real repository

1. **Create a webhook proxy** so GitHub can reach your laptop: open <https://smee.io/new> and
   copy the channel URL.
2. **Create a GitHub App**: GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   - Homepage URL: anything (e.g. this repo's URL)
   - Webhook URL: your smee.io channel URL
   - Webhook secret: a random string (`openssl rand -hex 32`)
   - Repository permissions:
     - **Pull requests**: Read and write (to post reviews)
     - **Contents**: Read-only (to read changed files)
     - Metadata: Read-only (default)
   - Subscribe to events: **Pull request**
   - Where can this app be installed: Only on this account
3. After creating it, note the **App ID** and click **Generate a private key** (downloads a `.pem`).
4. **Install the App** (left sidebar → Install App) on a test repository.
5. Configure and start:
   ```bash
   cp .env.example .env   # fill in GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET
   pnpm dev
   ```
6. In another terminal, forward webhooks to your machine:
   ```bash
   pnpm dlx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/api/github/webhooks
   ```
7. Open a PR in the test repository that adds something like `<button>Add to cart</button>` in a
   `.tsx` file. The bot should leave a review within a few seconds.

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

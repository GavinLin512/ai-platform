// Demo data for the dashboard: 30 days of reviews on three repositories.
//
//   DATABASE_URL=postgres://… pnpm --filter @l10n-review/db seed
//
// Deterministic (seeded random numbers), so every run produces the same picture.

import { sql } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";
import { findings, llmUsage, reviews } from "./schema.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL");
  process.exit(1);
}

let state = 20261104;
/** Mulberry32: a tiny seeded PRNG. Math.random() would give a different dataset every run. */
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

const RULES = [
  ["no-hardcoded-string", 30],
  ["zh-tw-terminology", 18],
  ["locale-keys", 16],
  ["locale-placeholders", 9],
  ["intl-format", 12],
  ["translation-meaning", 6],
] as const;
const weighted = () => {
  const total = RULES.reduce((n, [, w]) => n + w, 0);
  let roll = random() * total;
  for (const [rule, weight] of RULES) {
    roll -= weight;
    if (roll <= 0) return rule;
  }
  return RULES[0][0];
};
const RESOLVE_RATE: Record<string, number> = {
  "no-hardcoded-string": 0.55,
  "zh-tw-terminology": 0.8,
  "locale-keys": 0.7,
  "locale-placeholders": 0.9,
  "intl-format": 0.45,
  "translation-meaning": 0.6,
};

const database = createDatabase(url);
await migrateDatabase(database);
const { db } = database;
await db.execute(sql`truncate ${reviews} cascade`);

const day = 24 * 3600 * 1000;
const start = Date.now() - 29 * day;
let pullNumber = 100;
let runs = 0;

for (const repo of ["acme/shop", "acme/storefront", "acme/admin"]) {
  for (let pr = 0; pr < between(8, 12); pr++) {
    pullNumber++;
    let at = start + random() * 28 * day;
    let open: { fingerprint: string; ruleId: string }[] = [];

    for (let push = 0; push < between(1, 4) && at < Date.now(); push++) {
      runs++;
      const startedAt = new Date(at);
      // Earlier issues get fixed between pushes; a few new ones appear.
      open = open.filter((f) => random() > (RESOLVE_RATE[f.ruleId] ?? 0.5));
      const fresh = Array.from({ length: push === 0 ? between(0, 6) : between(0, 2) }, () => ({
        fingerprint: `${repo}#${pullNumber}:${runs}:${random().toString(36).slice(2, 10)}`,
        ruleId: weighted(),
      }));

      const [review] = await db
        .insert(reviews)
        .values({
          repo,
          pullNumber,
          headSha: random().toString(16).slice(2, 12),
          status: random() < 0.04 ? "failed" : "completed",
          filesChecked: between(1, 12),
          findings: open.length + fresh.length,
          alreadyReported: open.length,
          posted: fresh.length,
          startedAt,
          finishedAt: new Date(at + between(3, 40) * 1000),
        })
        .returning({ id: reviews.id, status: reviews.status });
      if (!review) continue;
      if (review.status === "failed") continue;

      const all = [
        ...open.map((f) => ({ ...f, isNew: false })),
        ...fresh.map((f) => ({ ...f, isNew: true })),
      ];
      if (all.length > 0) {
        await db.insert(findings).values(
          all.map((f) => ({
            reviewId: review.id,
            repo,
            pullNumber,
            ruleId: f.ruleId,
            path:
              f.ruleId.startsWith("locale") || f.ruleId.includes("zh-tw")
                ? "locales/zh-TW.json"
                : "src/Checkout.tsx",
            line: between(2, 120),
            severity: f.ruleId === "locale-placeholders" ? "error" : "warning",
            fingerprint: f.fingerprint,
            message: "Demo finding",
            isNew: f.isNew,
            createdAt: startedAt,
          })),
        );
      }
      // About half the runs touch Chinese strings and call the model (Opus 5.5 prices).
      if (random() < 0.5) {
        const input = between(1500, 9000);
        const output = between(150, 900);
        const cached = between(0, 1) * between(800, 1600);
        await db.insert(llmUsage).values(
          ["terminology.judge", "terminology.verify"].slice(0, between(1, 2)).map((purpose) => ({
            reviewId: review.id,
            purpose,
            model: "claude-opus-5-5",
            inputTokens: input,
            outputTokens: output,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cached,
            costUsd: (input * 4 + output * 20 + cached * 0.2) / 1_000_000,
            createdAt: startedAt,
          })),
        );
      }
      open = all.map(({ fingerprint, ruleId }) => ({ fingerprint, ruleId }));
      at += between(1, 30) * 3600 * 1000;
    }
  }
}

console.log(`Seeded ${runs} reviews on 3 repositories.`);
await database.close();

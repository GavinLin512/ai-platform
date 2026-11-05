import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  costByModel,
  createDatabase,
  findingsPerDay,
  overview,
  recentReviews,
  reviewStore,
  rulesSummary,
  schema,
} from "../src/index.ts";
import { migrateDatabase } from "../src/migrate.ts";

const url = process.env.DATABASE_URL;

const finding = (ruleId: string, fingerprint: string, isNew: boolean) => ({
  ruleId,
  path: "locales/zh-TW.json",
  line: 2,
  severity: "warning",
  fingerprint,
  message: "…",
  isNew,
});
const totals = { filesChecked: 1, findings: 0, alreadyReported: 0, posted: 0 };

describe.skipIf(!url)("dashboard queries (Postgres)", () => {
  const database = createDatabase(url ?? "");
  const store = reviewStore(database.db);
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  let first = "";

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.db.execute(sql`truncate ${schema.reviews} cascade`);

    // PR 1: first run reports f1 and f2; the second run only still has f2 → f1 resolved.
    first = await store.start({ repo: "acme/shop", pullNumber: 1, headSha: "a1" });
    await store.complete(
      first,
      totals,
      [finding("rule-x", "f1", true), finding("rule-y", "f2", true)],
      [
        {
          purpose: "terminology.judge",
          model: "claude-opus-5-5",
          inputTokens: 1000,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 500,
          costUsd: 0.01,
        },
        {
          purpose: "terminology.verify",
          model: "claude-opus-5-5",
          inputTokens: 2000,
          outputTokens: 200,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsd: 0.02,
        },
      ],
    );
    const second = await store.start({ repo: "acme/shop", pullNumber: 1, headSha: "a2" });
    await store.complete(second, totals, [finding("rule-y", "f2", false)]);

    // PR 2: f3 reported and still present in its latest run → not resolved.
    const third = await store.start({ repo: "acme/shop", pullNumber: 2, headSha: "b1" });
    await store.complete(third, totals, [finding("rule-x", "f3", true)]);

    // Make the run order explicit instead of relying on insert timing.
    const order: [string, number][] = [
      [first, 30],
      [second, 20],
      [third, 10],
    ];
    for (const [id, minutesAgo] of order) {
      await database.db
        .update(schema.reviews)
        .set({ startedAt: new Date(Date.now() - minutesAgo * 60_000) })
        .where(eq(schema.reviews.id, id));
    }
  });
  afterAll(() => database.close());

  it("summarizes the period", async () => {
    expect(await overview(database.db, since)).toEqual({
      reviews: 3,
      repos: 1,
      newFindings: 3,
      costUsd: 0.03,
    });
  });

  it("counts an issue as resolved once the latest run of its PR no longer has it", async () => {
    expect(await rulesSummary(database.db, since)).toEqual([
      { ruleId: "rule-x", reported: 2, resolved: 1 }, // f1 resolved, f3 still open
      { ruleId: "rule-y", reported: 1, resolved: 0 }, // f2 still open
    ]);
  });

  it("fills days without findings with zero", async () => {
    const days = await findingsPerDay(database.db, since);
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.findings)).toEqual([0, 0, 3]);
  });

  it("adds up cost per model", async () => {
    expect(await costByModel(database.db, since)).toEqual([
      {
        model: "claude-opus-5-5",
        calls: 2,
        inputTokens: 3000,
        outputTokens: 300,
        cacheReadInputTokens: 500,
        costUsd: 0.03,
      },
    ]);
  });

  it("lists recent runs newest first, with their LLM cost", async () => {
    const runs = await recentReviews(database.db, 10);
    expect(runs.map((r) => [r.pullNumber, r.headSha, r.costUsd])).toEqual([
      [2, "b1", 0],
      [1, "a2", 0],
      [1, "a1", 0.03],
    ]);
  });
});

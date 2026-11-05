import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, reviewStore, schema } from "../src/index.ts";
import { migrateDatabase } from "../src/migrate.ts";

// Integration test against a real Postgres. Locally: docker compose up db, then
// DATABASE_URL=postgres://postgres:postgres@localhost:5432/l10n_test pnpm test.
// CI provides one as a service container. Without DATABASE_URL the suite is skipped.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("reviewStore (Postgres)", () => {
  const database = createDatabase(url ?? "");
  const store = reviewStore(database.db);

  beforeAll(async () => {
    // Two instances starting at once must not race: the advisory lock serialises them.
    await Promise.all([migrateDatabase(database), migrateDatabase(database)]);
  });
  beforeEach(async () => {
    await database.db.execute(sql`truncate ${schema.reviews} cascade`);
  });
  afterAll(() => database.close());

  it("records a completed run with its findings in one transaction", async () => {
    const id = await store.start({
      repo: "acme/shop",
      pullNumber: 7,
      headSha: "abc",
      deliveryId: "d1",
    });
    await store.complete(id, { filesChecked: 2, findings: 2, alreadyReported: 1, posted: 1 }, [
      {
        ruleId: "locale-keys",
        path: "locales/en.json",
        line: 3,
        severity: "warning",
        fingerprint: "f1",
        message: "…",
        isNew: true,
      },
      {
        ruleId: "no-hardcoded-string",
        path: "src/A.tsx",
        line: 9,
        severity: "warning",
        fingerprint: "f2",
        message: "…",
        isNew: false,
      },
    ]);

    const [review] = await database.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, id));
    expect(review).toMatchObject({ status: "completed", posted: 1, alreadyReported: 1 });
    expect(review?.finishedAt).toBeInstanceOf(Date);

    const rows = await database.db
      .select()
      .from(schema.findings)
      .orderBy(desc(schema.findings.line));
    expect(rows.map((r) => [r.repo, r.pullNumber, r.ruleId, r.isNew])).toEqual([
      ["acme/shop", 7, "no-hardcoded-string", false],
      ["acme/shop", 7, "locale-keys", true],
    ]);
  });

  it("records the LLM usage of a run, with numeric cost", async () => {
    const id = await store.start({ repo: "acme/shop", pullNumber: 10, headSha: "jkl" });
    await store.complete(
      id,
      { filesChecked: 1, findings: 0, alreadyReported: 0, posted: 0 },
      [],
      [
        {
          purpose: "terminology.judge",
          model: "claude-opus-5-5",
          inputTokens: 1200,
          outputTokens: 300,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 900,
          costUsd: 0.01098,
        },
        {
          purpose: "terminology.verify",
          model: "unknown-model",
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      ],
    );
    const rows = await database.db.select().from(schema.llmUsage).orderBy(schema.llmUsage.purpose);
    expect(rows.map((r) => [r.purpose, r.costUsd])).toEqual([
      ["terminology.judge", 0.01098],
      ["terminology.verify", null],
    ]);
  });

  it("records a failure", async () => {
    const id = await store.start({ repo: "acme/shop", pullNumber: 8, headSha: "def" });
    await store.fail(id, new Error("GitHub said 502"));
    const [review] = await database.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, id));
    expect(review).toMatchObject({ status: "failed", error: "Error: GitHub said 502" });
  });

  it("deletes findings with their review", async () => {
    const id = await store.start({ repo: "acme/shop", pullNumber: 9, headSha: "ghi" });
    await store.complete(id, { filesChecked: 1, findings: 1, alreadyReported: 0, posted: 1 }, [
      {
        ruleId: "x",
        path: "a",
        line: 1,
        severity: "warning",
        fingerprint: "f",
        message: "m",
        isNew: true,
      },
    ]);
    await database.db.delete(schema.reviews).where(eq(schema.reviews.id, id));
    expect(await database.db.select().from(schema.findings)).toEqual([]);
  });
});

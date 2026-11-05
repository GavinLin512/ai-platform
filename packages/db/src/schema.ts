import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Like a Laravel migration + model rolled into one: Drizzle reads this file to generate SQL
// migrations (pnpm db:generate) and to type every query.

export const reviewStatus = pgEnum("review_status", ["running", "completed", "failed"]);

/** One run of the reviewer on one commit of a pull request. */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** "owner/name" */
    repo: text().notNull(),
    pullNumber: integer().notNull(),
    headSha: text().notNull(),
    /** GitHub's X-GitHub-Delivery, to trace a run back to its webhook. */
    deliveryId: text(),
    status: reviewStatus().notNull().default("running"),
    filesChecked: integer(),
    findings: integer(),
    alreadyReported: integer(),
    posted: integer(),
    error: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.repo, t.pullNumber), index().on(t.startedAt)],
);

/**
 * Every finding of every run, including ones already reported earlier. Comparing runs of the
 * same pull request tells which issues were fixed: their fingerprint stops appearing.
 */
export const findings = pgTable(
  "findings",
  {
    id: uuid().primaryKey().defaultRandom(),
    reviewId: uuid()
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    repo: text().notNull(),
    pullNumber: integer().notNull(),
    ruleId: text().notNull(),
    path: text().notNull(),
    line: integer().notNull(),
    severity: text().notNull(),
    fingerprint: text().notNull(),
    message: text().notNull(),
    /** New in this run (posted or capped) vs. already reported by an earlier run. */
    isNew: boolean().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.reviewId),
    index().on(t.repo, t.ruleId),
    index().on(t.repo, t.pullNumber, t.fingerprint),
  ],
);

/** One LLM call made during a run: tokens and cost, for the dashboard's cost view. */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid().primaryKey().defaultRandom(),
    reviewId: uuid()
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    /** e.g. "terminology.judge", "meaning.verify" */
    purpose: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    cacheCreationInputTokens: integer().notNull(),
    cacheReadInputTokens: integer().notNull(),
    /** Money is numeric, never a float. Null when the model's price is unknown. */
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.reviewId)],
);

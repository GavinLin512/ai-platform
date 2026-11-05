import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { findings, llmUsage, reviews } from "./schema.ts";

export interface ReviewStart {
  repo: string;
  pullNumber: number;
  headSha: string;
  deliveryId?: string;
}

export interface ReviewTotals {
  filesChecked: number;
  findings: number;
  alreadyReported: number;
  posted: number;
}

export interface RecordedFinding {
  ruleId: string;
  path: string;
  line: number;
  severity: string;
  fingerprint: string;
  message: string;
  isNew: boolean;
}

export interface RecordedLlmUsage {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd?: number;
}

/** Records review runs, so the dashboard can show trends without asking GitHub. */
export function reviewStore(db: Db) {
  return {
    async start(input: ReviewStart): Promise<string> {
      const [row] = await db.insert(reviews).values(input).returning({ id: reviews.id });
      if (!row) throw new Error("insert into reviews returned no row");
      return row.id;
    },

    async complete(
      id: string,
      totals: ReviewTotals,
      found: RecordedFinding[],
      usage: RecordedLlmUsage[] = [],
    ): Promise<void> {
      // One transaction: a run is either fully recorded or not at all.
      await db.transaction(async (tx) => {
        const [review] = await tx
          .update(reviews)
          .set({ ...totals, status: "completed", finishedAt: new Date() })
          .where(eq(reviews.id, id))
          .returning({ repo: reviews.repo, pullNumber: reviews.pullNumber });
        if (!review) return;
        if (found.length > 0) {
          await tx.insert(findings).values(found.map((f) => ({ ...f, ...review, reviewId: id })));
        }
        if (usage.length > 0) {
          await tx
            .insert(llmUsage)
            .values(usage.map((u) => ({ ...u, costUsd: u.costUsd ?? null, reviewId: id })));
        }
      });
    },

    async fail(id: string, error: unknown): Promise<void> {
      await db
        .update(reviews)
        .set({ status: "failed", error: String(error), finishedAt: new Date() })
        .where(eq(reviews.id, id));
    },
  };
}

export type ReviewStore = ReturnType<typeof reviewStore>;

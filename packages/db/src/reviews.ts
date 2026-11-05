import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { findings, reviews } from "./schema.ts";

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

/** Records review runs, so the dashboard can show trends without asking GitHub. */
export function reviewStore(db: Db) {
  return {
    async start(input: ReviewStart): Promise<string> {
      const [row] = await db.insert(reviews).values(input).returning({ id: reviews.id });
      if (!row) throw new Error("insert into reviews returned no row");
      return row.id;
    },

    async complete(id: string, totals: ReviewTotals, found: RecordedFinding[]): Promise<void> {
      // One transaction: a run is either fully recorded or not at all.
      await db.transaction(async (tx) => {
        const [review] = await tx
          .update(reviews)
          .set({ ...totals, status: "completed", finishedAt: new Date() })
          .where(eq(reviews.id, id))
          .returning({ repo: reviews.repo, pullNumber: reviews.pullNumber });
        if (!review || found.length === 0) return;
        await tx.insert(findings).values(found.map((f) => ({ ...f, ...review, reviewId: id })));
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

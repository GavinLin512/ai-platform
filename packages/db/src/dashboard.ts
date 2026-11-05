import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";

// The dashboard's queries, as plain SQL: aggregations read better in SQL than in a query
// builder, and these are the queries worth explaining in an interview.

/**
 * Raw sql`` parameters are sent as-is: the driver does not serialize a Date there (the query
 * builder would). Send ISO 8601 text and cast it in SQL.
 */
const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

export interface Overview {
  reviews: number;
  repos: number;
  newFindings: number;
  costUsd: number;
}

export async function overview(db: Db, since: Date): Promise<Overview> {
  const [row] = await db.execute<{
    reviews: number;
    repos: number;
    new_findings: number;
    cost_usd: number;
  }>(sql`
    select
      (select count(*)::int from reviews where started_at >= ${ts(since)}) as reviews,
      (select count(distinct repo)::int from reviews where started_at >= ${ts(since)}) as repos,
      (select count(*)::int from findings where is_new and created_at >= ${ts(since)}) as new_findings,
      (select coalesce(sum(cost_usd), 0)::float8 from llm_usage where created_at >= ${ts(since)}) as cost_usd
  `);
  return {
    reviews: row?.reviews ?? 0,
    repos: row?.repos ?? 0,
    newFindings: row?.new_findings ?? 0,
    costUsd: row?.cost_usd ?? 0,
  };
}

/** New findings per UTC day, with empty days as zero (generate_series), so charts have no gaps. */
export async function findingsPerDay(
  db: Db,
  since: Date,
): Promise<{ day: string; findings: number }[]> {
  return [
    ...(await db.execute<{ day: string; findings: number }>(sql`
      select to_char(d, 'YYYY-MM-DD') as day, count(f.id)::int as findings
      from generate_series(
        date_trunc('day', ${ts(since)}),
        date_trunc('day', now()),
        interval '1 day'
      ) as d
      left join findings f
        on f.is_new and f.created_at >= d and f.created_at < d + interval '1 day'
      group by d
      order by d
    `)),
  ];
}

export interface RuleSummary {
  ruleId: string;
  /** Distinct issues reported (one per pull request and fingerprint). */
  reported: number;
  /** Of those, gone from the latest completed review of their pull request. */
  resolved: number;
}

/**
 * How many reported issues got resolved, per rule. An issue is resolved when its fingerprint
 * no longer appears in the most recent completed review of the same pull request: the author
 * localized the string, fixed the placeholder, or removed the line.
 */
export async function rulesSummary(db: Db, since: Date): Promise<RuleSummary[]> {
  const rows = await db.execute<{ rule_id: string; reported: number; resolved: number }>(sql`
    with reported as (
      select repo, pull_number, fingerprint, min(rule_id) as rule_id
      from findings
      where is_new and created_at >= ${ts(since)}
      group by repo, pull_number, fingerprint
    ),
    latest as (
      select distinct on (repo, pull_number) id, repo, pull_number
      from reviews
      where status = 'completed'
      order by repo, pull_number, started_at desc
    )
    select
      r.rule_id,
      count(*)::int as reported,
      count(*) filter (
        where not exists (
          select 1 from findings f where f.review_id = l.id and f.fingerprint = r.fingerprint
        )
      )::int as resolved
    from reported r
    join latest l on l.repo = r.repo and l.pull_number = r.pull_number
    group by r.rule_id
    order by reported desc, r.rule_id
  `);
  return rows.map((r) => ({ ruleId: r.rule_id, reported: r.reported, resolved: r.resolved }));
}

export interface ModelCost {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
}

export async function costByModel(db: Db, since: Date): Promise<ModelCost[]> {
  const rows = await db.execute<{
    model: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cost_usd: number;
  }>(sql`
    select model,
      count(*)::int as calls,
      sum(input_tokens)::int as input_tokens,
      sum(output_tokens)::int as output_tokens,
      sum(cache_read_input_tokens)::int as cache_read_input_tokens,
      coalesce(sum(cost_usd), 0)::float8 as cost_usd
    from llm_usage
    where created_at >= ${ts(since)}
    group by model
    order by cost_usd desc
  `);
  return rows.map((r) => ({
    model: r.model,
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    costUsd: r.cost_usd,
  }));
}

export interface RecentReview {
  id: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  status: "running" | "completed" | "failed";
  findings: number | null;
  posted: number | null;
  costUsd: number;
  startedAt: Date;
}

export async function recentReviews(db: Db, limit = 20): Promise<RecentReview[]> {
  const rows = await db.execute<{
    id: string;
    repo: string;
    pull_number: number;
    head_sha: string;
    status: RecentReview["status"];
    findings: number | null;
    posted: number | null;
    cost_usd: number;
    started_at: Date;
  }>(sql`
    select r.id, r.repo, r.pull_number, r.head_sha, r.status, r.findings, r.posted,
      coalesce((select sum(u.cost_usd) from llm_usage u where u.review_id = r.id), 0)::float8 as cost_usd,
      r.started_at
    from reviews r
    order by r.started_at desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    pullNumber: r.pull_number,
    headSha: r.head_sha,
    status: r.status,
    findings: r.findings,
    posted: r.posted,
    costUsd: r.cost_usd,
    startedAt: new Date(r.started_at),
  }));
}

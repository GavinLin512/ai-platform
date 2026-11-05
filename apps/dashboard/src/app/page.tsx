import {
  costByModel,
  findingsPerDay,
  overview,
  recentReviews,
  rulesSummary,
} from "@l10n-review/db";
import { cookies } from "next/headers";
import { FindingsChart } from "@/components/FindingsChart";
import { Meter } from "@/components/Meter";
import { StatTile } from "@/components/StatTile";
import { StatusBadge } from "@/components/StatusBadge";
import { authConfig } from "@/lib/auth-config";
import { getDatabase } from "@/lib/db";
import { formatCount, formatDateTime, formatDay, formatPercent, formatUsd } from "@/lib/format";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

// A server component: the queries run on the server, the browser gets HTML plus the one
// interactive chart. force-dynamic: always read fresh data, never a build-time snapshot.
export const dynamic = "force-dynamic";

const DAYS = 30;

export default async function DashboardPage() {
  const { db } = getDatabase();
  const since = new Date(Date.now() - (DAYS - 1) * 24 * 3600 * 1000);

  const [summary, perDay, rules, costs, runs] = await Promise.all([
    overview(db, since),
    findingsPerDay(db, since),
    rulesSummary(db, since),
    costByModel(db, since),
    recentReviews(db, 15),
  ]);
  const reported = rules.reduce((n, r) => n + r.reported, 0);
  const resolved = rules.reduce((n, r) => n + r.resolved, 0);
  const days = perDay.map((d) => ({ ...d, label: formatDay(d.day) }));

  const auth = authConfig();
  const session =
    auth.mode === "github"
      ? verifySession((await cookies()).get(SESSION_COOKIE)?.value, auth.sessionSecret)
      : undefined;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">l10n-review</h1>
          <p className="text-sm text-secondary">Last {DAYS} days · times in UTC</p>
        </div>
        {auth.mode === "off" ? (
          <p className="text-xs text-muted">Sign-in disabled (development)</p>
        ) : session ? (
          <form action="/api/auth/logout" method="post" className="flex items-center gap-3 text-sm">
            <span className="text-secondary">@{session.login}</span>
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-secondary ring-1 ring-gridline hover:text-ink"
            >
              Sign out
            </button>
          </form>
        ) : null}
      </header>

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Reviews"
          value={formatCount(summary.reviews)}
          detail={`${summary.repos} repositories`}
        />
        <StatTile label="New findings" value={formatCount(summary.newFindings)} />
        <StatTile
          label="Resolved"
          value={reported === 0 ? "–" : formatPercent(resolved / reported)}
          detail={`${formatCount(resolved)} of ${formatCount(reported)} issues`}
        />
        <StatTile label="LLM cost" value={formatUsd(summary.costUsd)} />
      </section>

      <section className="min-w-0 rounded-xl bg-surface p-4 ring-1 ring-gridline">
        <h2 className="font-medium">New findings per day</h2>
        <div className="mt-3">
          <FindingsChart days={days} />
        </div>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-secondary">Show as table</summary>
          <table className="mt-2 w-full max-w-xs text-left">
            <thead className="text-muted">
              <tr>
                <th className="py-1 font-normal">Day</th>
                <th className="py-1 text-right font-normal">New findings</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-t border-gridline">
                  <td className="py-1">{d.label}</td>
                  <td className="py-1 text-right tabular-nums">{d.findings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="min-w-0 rounded-xl bg-surface p-4 ring-1 ring-gridline">
          <h2 className="font-medium">Issues by rule</h2>
          <p className="text-xs text-muted">
            Resolved: gone from the latest review of its pull request (fixed, or the line was
            removed).
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="data-table w-full text-left text-sm">
              <thead className="text-muted">
                <tr>
                  <th className="whitespace-nowrap py-2 font-normal">Rule</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Reported</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Resolved</th>
                  <th className="whitespace-nowrap py-2 pl-4 font-normal">Resolved rate</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const rate = rule.reported === 0 ? 0 : rule.resolved / rule.reported;
                  return (
                    <tr key={rule.ruleId} className="border-t border-gridline">
                      <td className="whitespace-nowrap py-2 font-mono text-xs">{rule.ruleId}</td>
                      <td className="py-2 text-right tabular-nums">{formatCount(rule.reported)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCount(rule.resolved)}</td>
                      <td className="py-2 pl-4">
                        <div className="flex items-center gap-2">
                          <Meter ratio={rate} />
                          <span className="w-10 text-right tabular-nums text-secondary">
                            {formatPercent(rate)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-muted">
                      No findings yet
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="min-w-0 rounded-xl bg-surface p-4 ring-1 ring-gridline">
          <h2 className="font-medium">LLM cost by model</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="data-table w-full text-left text-sm">
              <thead className="text-muted">
                <tr>
                  <th className="whitespace-nowrap py-2 font-normal">Model</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Calls</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Input</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Output</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Cache reads</th>
                  <th className="whitespace-nowrap py-2 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.model} className="border-t border-gridline">
                    <td className="whitespace-nowrap py-2 font-mono text-xs">{c.model}</td>
                    <td className="py-2 text-right tabular-nums">{formatCount(c.calls)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCount(c.inputTokens)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCount(c.outputTokens)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatCount(c.cacheReadInputTokens)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(c.costUsd)}</td>
                  </tr>
                ))}
                {costs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted">
                      No LLM calls yet (set ANTHROPIC_API_KEY on the GitHub App to enable them)
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="min-w-0 rounded-xl bg-surface p-4 ring-1 ring-gridline">
        <h2 className="font-medium">Recent reviews</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="data-table w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="whitespace-nowrap py-2 font-normal">Started</th>
                <th className="whitespace-nowrap py-2 font-normal">Pull request</th>
                <th className="whitespace-nowrap py-2 font-normal">Commit</th>
                <th className="whitespace-nowrap py-2 font-normal">Status</th>
                <th className="whitespace-nowrap py-2 text-right font-normal">Findings</th>
                <th className="whitespace-nowrap py-2 text-right font-normal">Posted</th>
                <th className="whitespace-nowrap py-2 text-right font-normal">LLM cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-gridline">
                  <td className="whitespace-nowrap py-2 text-secondary">
                    {formatDateTime(run.startedAt)}
                  </td>
                  <td className="whitespace-nowrap py-2">
                    <a
                      href={`https://github.com/${run.repo}/pull/${run.pullNumber}`}
                      className="underline decoration-gridline underline-offset-4 hover:decoration-current"
                    >
                      {run.repo}#{run.pullNumber}
                    </a>
                  </td>
                  <td className="py-2 font-mono text-xs text-secondary">
                    {run.headSha.slice(0, 7)}
                  </td>
                  <td className="whitespace-nowrap py-2">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="py-2 text-right tabular-nums">{run.findings ?? "–"}</td>
                  <td className="py-2 text-right tabular-nums">{run.posted ?? "–"}</td>
                  <td className="py-2 text-right tabular-nums">
                    {run.costUsd > 0 ? formatUsd(run.costUsd) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

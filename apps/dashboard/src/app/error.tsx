"use client";

// Shown when a query fails (database unreachable, DATABASE_URL missing…).
export default function DashboardError({ error }: { error: Error }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-xl font-semibold">The dashboard could not load its data</h1>
      <p className="mt-2 text-secondary">
        Check that DATABASE_URL is set and the database is reachable. Details are in the server log.
      </p>
      <p className="mt-4 font-mono text-sm text-muted">{error.message}</p>
    </main>
  );
}

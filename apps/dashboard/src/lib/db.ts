import { createDatabase, type Database } from "@l10n-review/db";

// One connection pool per server process. In development Next re-evaluates modules on every
// change, so keep the pool on globalThis instead of opening a new one each time.
const globalForDb = globalThis as typeof globalThis & { l10nDatabase?: Database };

export function getDatabase(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  globalForDb.l10nDatabase ??= createDatabase(url, { max: 3 });
  return globalForDb.l10nDatabase;
}

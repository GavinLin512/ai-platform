import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client.ts";

// A separate entry point (@l10n-review/db/migrate): only processes that change the schema
// import it. The dashboard reads data and never bundles migration code or SQL files.

/** Any number, as long as every instance of the app uses the same one. */
const MIGRATION_LOCK = 4_021_000_001;

/**
 * Applies pending migrations. Several instances can start at once (a rolling deploy, two
 * replicas), so a Postgres advisory lock makes them take turns instead of racing. The lock is
 * held on one reserved connection: advisory locks belong to the connection that took them.
 */
export async function migrateDatabase(database: Database): Promise<void> {
  const connection = await database.sql.reserve();
  try {
    await connection`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await connection`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    connection.release();
  }
}

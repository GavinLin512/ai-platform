import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

// TS property names (pullNumber) map to snake_case columns (pull_number), as in Laravel.
const casing = "snake_case";

export function createDatabase(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, { max: options.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing });
  return {
    db,
    sql,
    /** Cheap readiness check for /readyz. */
    async ping(): Promise<boolean> {
      try {
        await sql`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export type Database = ReturnType<typeof createDatabase>;
export type Db = Database["db"];

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

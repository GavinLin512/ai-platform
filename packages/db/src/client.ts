import { drizzle } from "drizzle-orm/postgres-js";
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

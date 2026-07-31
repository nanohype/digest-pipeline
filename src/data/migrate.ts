/**
 * Minimal forward-only + single-step-rollback migrator.
 *
 *   npm run migrate:up        — applies every *.up.sql not yet recorded
 *   npm run migrate:down      — reverses the most recently applied migration
 *   npm run dev:migrate:up    — the same, straight from source via tsx
 *
 * Applied migrations are tracked in the schema_migrations table, which the
 * runner creates on first use. Each migration runs in its own transaction;
 * a failed migration rolls back and the run aborts.
 *
 * This lives under src/ because it has to ship. The chart runs `migrate:up` as
 * a pre-install/pre-upgrade hook inside the api image, and that image is built
 * with `npm prune --omit=dev` — so a migrator invoked through tsx, or one
 * sitting outside the compiled output, is not present at the moment the hook
 * needs it. Compiling it with everything else is what makes the hook runnable.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two levels up is the package root from both `src/data/` and `dist/data/`,
// which is why this file sits where it does: running from source under tsx and
// running the compiled copy in the image resolve to the same `migrations/`.
// The image gets that directory via an explicit COPY in Dockerfile.api — .sql
// files are data, so nothing in the TypeScript build would carry them.
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "migrations");

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT         PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
}

async function getApplied(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name ASC",
  );
  return rows.map((r) => r.name);
}

function listMigrationFiles(suffix: ".up.sql" | ".down.sql"): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(suffix))
    .sort();
}

function migrationName(file: string): string {
  return file.replace(/\.(up|down)\.sql$/u, "");
}

async function up(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool);
  const applied = new Set(await getApplied(pool));
  const files = listMigrationFiles(".up.sql");

  for (const file of files) {
    const name = migrationName(file);
    if (applied.has(name)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${name}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] failed ${name}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log("[migrate] up: done");
}

async function down(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1",
  );
  const last = rows[0]?.name;
  if (!last) {
    console.log("[migrate] down: nothing to roll back");
    return;
  }
  const file = `${last}.down.sql`;
  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE name = $1", [last]);
    await client.query("COMMIT");
    console.log(`[migrate] reverted ${last}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[migrate] failed to revert ${last}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "up" && command !== "down") {
    console.error("Usage: migrate up|down");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  try {
    if (command === "up") await up(pool);
    else await down(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

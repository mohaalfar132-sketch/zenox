#!/usr/bin/env node
/**
 * Creates a fresh ZENOX database and applies every drizzle/*.sql migration in order.
 * Usage: DATABASE_URL=mysql://user:pass@host:3306/zenox pnpm db:init
 * Idempotent: applied files are recorded in __zenox_migrations and never re-run.
 */
import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";

const dryRun = process.argv.includes("--dry-run");
const raw = process.env.DATABASE_URL?.trim();

if (!raw) {
  console.error("DATABASE_URL is not set. Add it to .env (chmod 600) or the server secret store.");
  console.error("Format: mysql://USER:PASSWORD@HOST:3306/DATABASE");
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch {
  console.error("DATABASE_URL is not a valid URL.");
  process.exit(1);
}

const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database) {
  console.error("DATABASE_URL must end with the database name, e.g. /zenox");
  process.exit(1);
}
if (!/^[A-Za-z0-9_$]+$/.test(database)) {
  console.error(`Refusing unsafe database name: ${database}`);
  process.exit(1);
}

const migrationDir = join(process.cwd(), "drizzle");
const files = existsSync(migrationDir)
  ? readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()
  : [];
if (files.length === 0) {
  console.error("No .sql migrations found in drizzle/.");
  process.exit(1);
}

if (dryRun) {
  console.log(`Would create database ${database} and apply ${files.length} migrations:`);
  for (const name of files) console.log(`  - ${name}`);
  process.exit(0);
}

const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  multipleStatements: false,
});

try {
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.query(`USE \`${database}\``);
  await connection.query(
    "CREATE TABLE IF NOT EXISTS `__zenox_migrations` (`name` VARCHAR(255) NOT NULL PRIMARY KEY, `applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB",
  );

  const [rows] = await connection.query("SELECT `name` FROM `__zenox_migrations`");
  const applied = new Set(rows.map((row) => String(row.name)));
  let count = 0;

  for (const name of files) {
    if (applied.has(name)) {
      console.log(`skip  ${name}`);
      continue;
    }
    const sql = readFileSync(join(migrationDir, name), "utf8");
    // Split on drizzle's `--> statement-breakpoint` delimiters FIRST (they start
    // with `--`, so stripping comments before splitting destroys them), then drop
    // whole-line `--` comments so a leading comment cannot swallow its statement.
    const statements = sql
      .split(/-->\s*statement-breakpoint/g)
      .map((chunk) =>
        chunk
          .split("\n")
          .map((line) => (line.trimStart().startsWith("--") ? "" : line))
          .join("\n")
          .trim(),
      )
      .filter((statement) => statement.length > 0);
    if (statements.length === 0) {
      console.error(`Refusing to record ${name}: it contains no executable statement.`);
      process.exitCode = 1;
      throw new Error(`${name} has no executable statements`);
    }
    for (const statement of statements) {
      try {
        await connection.query(statement);
      } catch (error) {
        console.error(`\nFailed in ${name}: ${error.message}`);
        console.error(`Statement: ${statement.slice(0, 300)}`);
        process.exitCode = 1;
        throw error;
      }
    }
    await connection.query("INSERT INTO `__zenox_migrations` (`name`) VALUES (?)", [name]);
    applied.add(name);
    count += 1;
    console.log(`apply ${name}`);
  }

  console.log(`\nDatabase ${database} is ready. Applied ${count} new migration(s), skipped ${files.length - count}.`);
} finally {
  await connection.end();
}

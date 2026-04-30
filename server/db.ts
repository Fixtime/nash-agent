import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";

const sqlite = new Database(path.join(process.cwd(), "nash.db"));
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Auto-migrate
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    analysis_mode TEXT NOT NULL DEFAULT 'nash',
    description TEXT NOT NULL,
    players TEXT NOT NULL,
    context TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER
  );
`);

const columns = sqlite.prepare("PRAGMA table_info(analyses);").all() as Array<{ name: string }>;
if (!columns.some((column) => column.name === "analysis_mode")) {
  sqlite.exec("ALTER TABLE analyses ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'nash';");
}

import { type Client, createClient } from "@libsql/client/web";

export type Database = Client;

export async function openDatabase(): Promise<Database> {
  const db = createClient({
    url: Deno.env.get("TURSO_URL")!,
    authToken: Deno.env.get("TURSO_TOKEN") || undefined,
  });
  await migrate(db);
  return db;
}

async function migrate(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const result = await db.execute("SELECT name FROM _migrations");
  const applied = new Set(result.rows.map((row) => String(row.name)));

  const migrationsDir = new URL("../migrations", import.meta.url);
  const files = [...Deno.readDirSync(migrationsDir)]
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = Deno.readTextFileSync(new URL(file, migrationsDir + "/"));
    // マイグレーション本体と適用記録を1つのトランザクションで流す(途中で失敗したら全て巻き戻る)
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await db.batch(
      [
        ...statements,
        {
          sql: "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
          args: [file, new Date().toISOString()],
        },
      ],
      "write",
    );
    console.log(`Applied migration: ${file}`);
  }
}

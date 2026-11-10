import type { Database } from "../db.ts";

export async function isSkipped(db: Database, userId: string, weekOf: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM weekly_skip WHERE discord_user_id = ? AND week_of = ?",
    args: [userId, weekOf],
  });
  return result.rows.length > 0;
}

export async function setSkip(db: Database, userId: string, weekOf: string): Promise<void> {
  await db.execute({
    sql: "INSERT OR IGNORE INTO weekly_skip (discord_user_id, week_of) VALUES (?, ?)",
    args: [userId, weekOf],
  });
}

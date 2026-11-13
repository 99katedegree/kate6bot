import type { Database } from "../db.ts";

/** フォームの入力欄の上限(Discordの仕様で4000文字まで) */
export const MAX_BIO_LENGTH = 4000;

export async function getBio(db: Database, userId: string): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT content FROM bios WHERE discord_user_id = ?",
    args: [userId],
  });
  const content = result.rows[0]?.content;
  return typeof content === "string" ? content : null;
}

/** 自己紹介を保存する(1人1件。既にあれば上書きする) */
export async function setBio(db: Database, userId: string, content: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO bios (discord_user_id, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    args: [userId, content, new Date().toISOString()],
  });
}

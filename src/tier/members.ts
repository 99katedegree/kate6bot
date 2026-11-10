import type { Database } from "../db.ts";
import { isTier, type Tier } from "./tiers.ts";

export async function getTier(db: Database, userId: string): Promise<Tier | null> {
  const result = await db.execute({
    sql: "SELECT tier FROM members WHERE discord_user_id = ?",
    args: [userId],
  });
  const tier = result.rows[0]?.tier;

  if (typeof tier !== "string" || !isTier(tier)) return null;
  return tier;
}

export async function setTier(db: Database, userId: string, tier: Tier): Promise<void> {
  await db.execute({
    sql: `INSERT INTO members (discord_user_id, tier, updated_at, pick_count)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(discord_user_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
    args: [userId, tier, new Date().toISOString()],
  });
}

/** 段位ロールを持っていない状態に合わせて、DB側も未設定に戻す。 */
export async function clearTier(db: Database, userId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO members (discord_user_id, tier, updated_at, pick_count)
     VALUES (?, NULL, ?, 0)
     ON CONFLICT(discord_user_id) DO UPDATE SET tier = NULL, updated_at = excluded.updated_at`,
    args: [userId, new Date().toISOString()],
  });
}

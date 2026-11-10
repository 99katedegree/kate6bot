import type { Database } from "../db.ts";
import { isSkipped } from "./skip.ts";
import { oneTierBelow, type Tier } from "../tier/tiers.ts";

/** 自分以外の、段位が一致(自分の段位 or 自分の段位-1)かつ今週スキップしていないメンバーの一覧 */
export async function buildPool(
  db: Database,
  selfUserId: string,
  selfTier: Tier,
  weekOf: string,
): Promise<string[]> {
  const below = oneTierBelow(selfTier);
  const eligibleTiers = below ? [selfTier, below] : [selfTier];
  const placeholders = eligibleTiers.map(() => "?").join(", ");

  const result = await db.execute({
    sql: `SELECT discord_user_id FROM members
       WHERE tier IN (${placeholders}) AND discord_user_id != ?`,
    args: [...eligibleTiers, selfUserId],
  });

  const pool: string[] = [];
  for (const row of result.rows) {
    const userId = String(row.discord_user_id);
    if (!(await isSkipped(db, userId, weekOf))) pool.push(userId);
  }
  return pool;
}

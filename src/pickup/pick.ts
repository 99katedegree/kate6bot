import type { Database } from "../db.ts";
import { isTopTier, type Tier } from "../tier/tiers.ts";

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function getPickCount(db: Database, userId: string): Promise<number> {
  const result = await db.execute({
    sql: "SELECT pick_count FROM members WHERE discord_user_id = ?",
    args: [userId],
  });
  return Number(result.rows[0]?.pick_count ?? 0);
}

async function getPairCount(db: Database, a: string, b: string): Promise<number> {
  const [userA, userB] = pairKey(a, b);
  const result = await db.execute({
    sql: "SELECT count FROM pair_history WHERE user_a = ? AND user_b = ?",
    args: [userA, userB],
  });
  return Number(result.rows[0]?.count ?? 0);
}
/** 重みに比例した確率で候補を1人選ぶ(ルーレット選択) */
function weightedPickOne(candidates: string[], weights: number[]): string {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

export interface PickResult {
  selected: string[];
}

/**
 * pool からニーズ人数を重み付き非復元抽選で選ぶ。
 * 重み = 1/(個人のpick_count+1) × すでに今回選んだ人との 1/(pair_count+1) の積。
 * 選ばれるほど、また同じペアになるほど確率は下がるが、ゼロにはならない。
 */
export async function pickGroup(
  db: Database,
  selfTier: Tier,
  pool: string[],
): Promise<PickResult | null> {
  const needed = isTopTier(selfTier) ? 1 : 3;
  if (pool.length < needed) return null;

  const remaining = [...pool];
  const selected: string[] = [];

  for (let i = 0; i < needed; i++) {
    const weights: number[] = [];
    for (const candidate of remaining) {
      const individualWeight = 1 / ((await getPickCount(db, candidate)) + 1);
      let pairWeight = 1;
      for (const s of selected) {
        pairWeight *= 1 / ((await getPairCount(db, candidate, s)) + 1);
      }
      weights.push(individualWeight * pairWeight);
    }

    const picked = weightedPickOne(remaining, weights);
    selected.push(picked);
    remaining.splice(remaining.indexOf(picked), 1);
  }

  // 抽選結果の反映(選出回数・ペア履歴)は1つのトランザクションでまとめて行う
  const updates = selected.map((userId) => ({
    sql: "UPDATE members SET pick_count = pick_count + 1 WHERE discord_user_id = ?",
    args: [userId],
  }));
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const [userA, userB] = pairKey(selected[i], selected[j]);
      updates.push({
        sql: `INSERT INTO pair_history (user_a, user_b, count) VALUES (?, ?, 1)
     ON CONFLICT(user_a, user_b) DO UPDATE SET count = count + 1`,
        args: [userA, userB],
      });
    }
  }
  await db.batch(updates, "write");

  return { selected };
}

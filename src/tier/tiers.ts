export const TIERS = ["1", "2", "3", "4", "5", "6", "勇士", "最高峰"] as const;

export type Tier = typeof TIERS[number];

/** 画面に表示する段位名。数字の段位は「1段」のように表示し、DBに保存する値は元のまま使う */
export function tierLabel(tier: Tier): string {
  return /^\d+$/.test(tier) ? `${tier}段` : tier;
}

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

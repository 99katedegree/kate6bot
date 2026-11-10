export const TIERS = ["1", "2", "3", "4", "5", "6", "勇士", "最高峰"] as const;

export type Tier = typeof TIERS[number];

export const TIER_ROLE_IDS: Record<Tier, bigint> = {
  "1": 1569391099418771567n,
  "2": 1569391354352762980n,
  "3": 1569391486888448194n,
  "4": 1569391626554450022n,
  "5": 1569391706170859540n,
  "6": 1569392111659385013n,
  "勇士": 1569392166420090980n,
  "最高峰": 1569392657564831794n,
};

/** 画面に表示する段位名。数字の段位は「1段」のように表示し、DBやロールの対応は元の値のまま使う */
export function tierLabel(tier: Tier): string {
  return /^\d+$/.test(tier) ? `${tier}段` : tier;
}

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function oneTierBelow(tier: Tier): Tier | null {
  const index = tierIndex(tier);
  return index === 0 ? null : TIERS[index - 1];
}

export function isTopTier(tier: Tier): boolean {
  return tier === "勇士" || tier === "最高峰";
}

/**
 * 現在保持しているロールの一覧から、段位ロールを探す。
 * ロールが常に正しい値として扱われる(管理者が直接ロールを操作した場合もここで拾われる)。
 * 複数の段位ロールを同時に持っている場合は不整合として扱い、先頭(低い段位)を採用する。
 */
export function extractTierFromRoles(
  roleIds: bigint[],
): { tier: Tier | null; hasConflict: boolean } {
  const matched = TIERS.filter((tier) => roleIds.includes(TIER_ROLE_IDS[tier]));
  return {
    tier: matched[0] ?? null,
    hasConflict: matched.length > 1,
  };
}

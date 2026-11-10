import type { Database } from "../db.ts";
import {
  type ChannelManager,
  deleteBioChannelRecord,
  displayName,
  ensureBioChannel,
  getAllBioChannels,
} from "./bio.ts";

interface GuildMember {
  nick?: string | null;
  user?: { id: bigint; username: string; globalName?: string | null; bot?: boolean };
}

export interface ReconcileBot {
  helpers: ChannelManager["helpers"] & {
    getMembers: (
      guildId: bigint,
      options: { limit?: number; after?: string },
    ) => Promise<GuildMember[]>;
    getChannel: (channelId: bigint) => Promise<unknown>;
    getChannels: (guildId: bigint) => Promise<{ id: bigint; parentId?: bigint }[]>;
    deleteChannel: (channelId: bigint, reason?: string) => Promise<void>;
  };
}

export interface ReconcileResult {
  memberCount: number;
  /** メンバーなのに自己紹介チャンネルが無かったため、新規作成した人 */
  created: string[];
  /** DB上は存在するがDiscord側のチャンネルが消えていたため、作り直した人 */
  recreated: string[];
  /** サーバーを抜けているため、チャンネルとDBレコードを削除した人 */
  removed: string[];
  /** 抜けた人が多すぎるため、安全のため削除を見送った人(要確認) */
  removalSkipped: string[];
  /** profileカテゴリー配下にあるが、DBに紐付いていないチャンネル(報告のみ。削除はしない) */
  untrackedChannels: string[];
  failed: string[];
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const profileCategoryId = BigInt(Deno.env.get("PROFILE_CATEGORY_ID")!);

/** 一度に削除を許す人数の下限。メンバー取得の異常などによる大量削除を防ぐ */
const MIN_REMOVAL_GUARD = 3;
const REMOVAL_GUARD_RATIO = 0.3;

function isNotFound(error: unknown): boolean {
  const message = String(error);
  return message.includes("404") || message.includes("Unknown Channel") ||
    message.includes("10003");
}

async function fetchAllMembers(bot: ReconcileBot): Promise<GuildMember[]> {
  const all: GuildMember[] = [];
  let after: string | undefined;
  while (true) {
    const page = await bot.helpers.getMembers(guildId, { limit: 1000, after });
    all.push(...page);
    const last = page.at(-1)?.user?.id;
    if (page.length < 1000 || last === undefined) break;
    after = last.toString();
  }
  return all;
}

/**
 * サーバーのメンバーと自己紹介チャンネルの差分を確認し、ズレを修復する。
 *  - 新しい人がいるのにチャンネルが無い → 作成
 *  - DBにはあるがDiscord上のチャンネルが消えている → 作り直し
 *  - 抜けた人のチャンネルが残っている → 削除
 *  - どの人にも紐付かないチャンネルが残っている → 報告のみ
 * メンバー一覧を取得できなかった場合は何も変更せずエラーを投げる。
 */
export async function reconcileBioChannels(
  bot: ReconcileBot,
  db: Database,
): Promise<ReconcileResult> {
  const members = (await fetchAllMembers(bot)).filter((m) => m.user && !m.user.bot);
  if (members.length === 0) {
    throw new Error("メンバー一覧が空だったため、安全のため中止しました");
  }

  const result: ReconcileResult = {
    memberCount: members.length,
    created: [],
    recreated: [],
    removed: [],
    removalSkipped: [],
    untrackedChannels: [],
    failed: [],
  };

  const memberById = new Map(members.map((m) => [m.user!.id.toString(), m]));
  const rows = await getAllBioChannels(db);
  const rowByUser = new Map(rows.map((row) => [row.userId, row]));

  // 1. メンバーなのにチャンネルが無い → 作成
  for (const [userId, member] of memberById) {
    if (rowByUser.has(userId)) continue;
    try {
      const channelId = await ensureBioChannel(bot, db, userId, displayName(member));
      rowByUser.set(userId, { userId, channelId: channelId.toString() });
      result.created.push(userId);
    } catch {
      result.failed.push(userId);
    }
  }

  // 2. DBにはあるがDiscord上のチャンネルが消えている → 作り直し
  for (const row of [...rowByUser.values()]) {
    const member = memberById.get(row.userId);
    if (!member || result.created.includes(row.userId)) continue;
    try {
      await bot.helpers.getChannel(BigInt(row.channelId));
    } catch (error) {
      if (!isNotFound(error)) {
        result.failed.push(row.userId);
        continue;
      }
      try {
        await deleteBioChannelRecord(db, row.userId);
        const channelId = await ensureBioChannel(bot, db, row.userId, displayName(member));
        rowByUser.set(row.userId, { userId: row.userId, channelId: channelId.toString() });
        result.recreated.push(row.userId);
      } catch {
        result.failed.push(row.userId);
      }
    }
  }

  // 3. 抜けた人のチャンネルが残っている → 削除(大量になる場合は安全のため見送る)
  const departed = [...rowByUser.values()].filter((row) => !memberById.has(row.userId));
  const guard = Math.max(MIN_REMOVAL_GUARD, Math.floor(rowByUser.size * REMOVAL_GUARD_RATIO));
  if (departed.length > guard) {
    result.removalSkipped = departed.map((row) => row.userId);
  } else {
    for (const row of departed) {
      try {
        await bot.helpers.deleteChannel(
          BigInt(row.channelId),
          "サーバーを抜けたメンバーの自己紹介チャンネル",
        );
      } catch (error) {
        if (!isNotFound(error)) {
          result.failed.push(row.userId);
          continue;
        }
      }
      try {
        await deleteBioChannelRecord(db, row.userId);
        rowByUser.delete(row.userId);
        result.removed.push(row.userId);
      } catch {
        result.failed.push(row.userId);
      }
    }
  }

  // 4. profileカテゴリー配下で、DBに紐付かないチャンネル → 報告のみ
  try {
    const knownChannelIds = new Set([...rowByUser.values()].map((row) => row.channelId));
    const channels = await bot.helpers.getChannels(guildId);
    result.untrackedChannels = channels
      .filter((c) => c.parentId === profileCategoryId && !knownChannelIds.has(c.id.toString()))
      .map((c) => c.id.toString());
  } catch {
    // 報告専用なので、取得できなくても他の結果は返す
  }

  return result;
}

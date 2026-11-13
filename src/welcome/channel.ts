import { ChannelTypes, OverwriteTypes } from "@discordeno/bot";
import type { Database } from "../db.ts";
import type { PermissionOverwrite } from "../profile/bio.ts";

interface WelcomeChannelManager {
  helpers: {
    createChannel: (
      guildId: bigint,
      options: {
        name: string;
        type: ChannelTypes;
        permissionOverwrites: PermissionOverwrite[];
      },
      reason?: string,
    ) => Promise<{ id: bigint }>;
    deleteChannel: (channelId: bigint, reason?: string) => Promise<void>;
    editChannelPermissionOverrides: (
      channelId: bigint,
      options: PermissionOverwrite,
      reason?: string,
    ) => Promise<void>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);

/** ウェルカム用チャンネルの名前。「【ようこそ】○○」のプレフィックス形式 */
export function welcomeChannelName(name: string): string {
  return `【ようこそ】${name}`;
}

/**
 * ウェルカム用チャンネルの権限。本人だけが見られる(投稿はできない)。
 * 権限を直接指定するとカテゴリーの設定は引き継がれないが、そもそもカテゴリーには入れない。
 */
export function welcomeChannelOverwrites(userId: string): PermissionOverwrite[] {
  return [
    { id: guildId, type: OverwriteTypes.Role, deny: ["VIEW_CHANNEL"] },
    {
      id: BigInt(userId),
      type: OverwriteTypes.Member,
      allow: ["VIEW_CHANNEL"],
      deny: ["SEND_MESSAGES"],
    },
  ];
}

export async function getWelcomeChannel(db: Database, userId: string): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT channel_id FROM welcome_channels WHERE discord_user_id = ?",
    args: [userId],
  });
  const id = result.rows[0]?.channel_id;
  return id === undefined ? null : String(id);
}

export async function findWelcomeChannelOwner(
  db: Database,
  channelId: string,
): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT discord_user_id FROM welcome_channels WHERE channel_id = ?",
    args: [channelId],
  });
  const id = result.rows[0]?.discord_user_id;
  return id === undefined ? null : String(id);
}

export async function getAllWelcomeChannels(
  db: Database,
): Promise<{ userId: string; channelId: string }[]> {
  const result = await db.execute("SELECT discord_user_id, channel_id FROM welcome_channels");
  return result.rows.map((row) => ({
    userId: String(row.discord_user_id),
    channelId: String(row.channel_id),
  }));
}

/**
 * 本人専用のウェルカム用チャンネルを作る。既に記録があれば、作り直さずにそのidを返す。
 * created は、今回新しく作った場合だけ true(案内メッセージを送るかどうかの判断に使う)。
 */
export async function ensureWelcomeChannel(
  bot: WelcomeChannelManager,
  db: Database,
  userId: string,
  name: string,
): Promise<{ id: bigint; created: boolean }> {
  const existing = await getWelcomeChannel(db, userId);
  if (existing) return { id: BigInt(existing), created: false };

  const channel = await bot.helpers.createChannel(
    guildId,
    {
      name: welcomeChannelName(name),
      type: ChannelTypes.GuildText,
      permissionOverwrites: welcomeChannelOverwrites(userId),
    },
    "入室者向けウェルカム用チャンネルの作成",
  );
  await db.execute({
    sql: "INSERT INTO welcome_channels (discord_user_id, channel_id) VALUES (?, ?)",
    args: [userId, channel.id.toString()],
  });
  return { id: channel.id, created: true };
}

/** ウェルカム用チャンネルを削除して、記録も消す。既に無ければ何もしない。削除したら true。 */
export async function deleteWelcomeChannel(
  bot: WelcomeChannelManager,
  db: Database,
  userId: string,
  reason: string,
): Promise<boolean> {
  const channelId = await getWelcomeChannel(db, userId);
  if (!channelId) return false;
  try {
    await bot.helpers.deleteChannel(BigInt(channelId), reason);
  } catch {
    // 既に削除されている場合などは無視して、記録だけ消す
  }
  await db.execute({
    sql: "DELETE FROM welcome_channels WHERE discord_user_id = ?",
    args: [userId],
  });
  return true;
}

/** 毎日の保守処理用。案内が完了した人・サーバーを抜けた人のウェルカム用チャンネルを片付け、残りは権限を整える。 */
export async function cleanupWelcomeChannels(
  bot: WelcomeChannelManager & {
    helpers: { getMember: (guildId: bigint, userId: bigint) => Promise<unknown> };
  },
  db: Database,
  isComplete: (userId: string) => Promise<boolean>,
  log: (message: string) => Promise<void>,
): Promise<void> {
  for (const { userId, channelId } of await getAllWelcomeChannels(db)) {
    try {
      let reason: string | null = null;
      if (await isComplete(userId)) {
        reason = "段位の設定と自己紹介の投稿が済んでいるため";
      } else {
        try {
          await bot.helpers.getMember(guildId, BigInt(userId));
        } catch (error) {
          const status = (error as { cause?: { status?: number } })?.cause?.status;
          if (status === 404 || String(error).includes("404")) reason = "サーバーを抜けているため";
          else throw error;
        }
      }

      if (reason) {
        await deleteWelcomeChannel(bot, db, userId, `ウェルカム用チャンネルの片付け: ${reason}`);
        await log(`ウェルカム用チャンネルを削除しました(user=${userId}, 理由=${reason})`);
        continue;
      }

      for (const overwrite of welcomeChannelOverwrites(userId)) {
        await bot.helpers.editChannelPermissionOverrides(
          BigInt(channelId),
          overwrite,
          "ウェルカム用チャンネルの権限を再適用",
        );
      }
    } catch (error) {
      await log(`ウェルカム用チャンネルの確認に失敗しました(user=${userId}): ${error}`);
    }
  }
}

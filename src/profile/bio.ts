import { ChannelTypes, OverwriteTypes, type PermissionStrings } from "@discordeno/bot";
import type { Database } from "../db.ts";

interface ChannelManager {
  helpers: {
    createChannel: (
      guildId: bigint,
      options: {
        name: string;
        type: ChannelTypes;
        parentId: bigint;
        permissionOverwrites: { id: bigint; type: OverwriteTypes; allow: PermissionStrings[] }[];
      },
      reason?: string,
    ) => Promise<{ id: bigint }>;
    deleteMessage: (channelId: bigint, messageId: bigint, reason?: string) => Promise<void>;
    getMessage: (channelId: bigint, messageId: bigint) => Promise<{ content: string }>;
    getUser: (id: bigint) => Promise<{ username: string }>;
    editChannel: (
      channelId: bigint,
      options: { name: string },
      reason?: string,
    ) => Promise<unknown>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const profileCategoryId = BigInt(Deno.env.get("PROFILE_CATEGORY_ID")!);

interface BioChannel {
  channelId: string;
  lastMessageId: string | null;
}

export async function getBioChannel(db: Database, userId: string): Promise<BioChannel | null> {
  const result = await db.execute({
    sql: "SELECT channel_id, last_message_id FROM bio_channels WHERE discord_user_id = ?",
    args: [userId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    channelId: String(row.channel_id),
    lastMessageId: row.last_message_id === null ? null : String(row.last_message_id),
  };
}

/** channel_id から、その自己紹介チャンネルの持ち主のuserIdを逆引きする */
export async function findBioChannelOwner(db: Database, channelId: string): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT discord_user_id FROM bio_channels WHERE channel_id = ?",
    args: [channelId],
  });
  const id = result.rows[0]?.discord_user_id;
  return id === undefined ? null : String(id);
}

export async function setLastMessageId(
  db: Database,
  userId: string,
  messageId: string,
): Promise<void> {
  await db.execute({
    sql: "UPDATE bio_channels SET last_message_id = ? WHERE discord_user_id = ?",
    args: [messageId, userId],
  });
}

/** 既に自己紹介チャンネルがあればそのidを返し、無ければ新規作成する。 */
export async function ensureBioChannel(
  bot: ChannelManager,
  db: Database,
  userId: string,
  username: string,
): Promise<bigint> {
  const existing = await getBioChannel(db, userId);
  if (existing) return BigInt(existing.channelId);

  const channel = await bot.helpers.createChannel(
    guildId,
    {
      name: `自己紹介-${username}`,
      type: ChannelTypes.GuildText,
      parentId: profileCategoryId,
      permissionOverwrites: [
        {
          id: BigInt(userId),
          type: OverwriteTypes.Member,
          allow: ["VIEW_CHANNEL", "SEND_MESSAGES"],
        },
      ],
    },
    "自己紹介チャンネルの初回作成",
  );

  await db.execute({
    sql:
      "INSERT INTO bio_channels (discord_user_id, channel_id, last_message_id) VALUES (?, ?, NULL)",
    args: [userId, channel.id.toString()],
  });

  return channel.id;
}

/** 新規投稿があったら、前回のメッセージを削除してから今回のものを最新として記録する。 */
export async function replaceBioMessage(
  bot: ChannelManager,
  db: Database,
  userId: string,
  channelId: bigint,
  newMessageId: bigint,
): Promise<void> {
  const existing = await getBioChannel(db, userId);
  if (existing?.lastMessageId) {
    try {
      await bot.helpers.deleteMessage(channelId, BigInt(existing.lastMessageId), "自己紹介の更新");
    } catch {
      // 既に削除されている場合などは無視
    }
  }
  await setLastMessageId(db, userId, newMessageId.toString());
}

export async function getAllBioChannels(
  db: Database,
): Promise<{ userId: string; channelId: string }[]> {
  const result = await db.execute("SELECT discord_user_id, channel_id FROM bio_channels");
  return result.rows.map((row) => ({
    userId: String(row.discord_user_id),
    channelId: String(row.channel_id),
  }));
}

/**
 * 全自己紹介チャンネルの名前を、現在のDiscordユーザー名に合わせて同期する。
 * ユーザー名が変わっていても、見た目のズレを日次で修復する。
 */
export async function syncBioChannelNames(
  bot: ChannelManager,
  db: Database,
): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];

  for (const { userId, channelId } of await getAllBioChannels(db)) {
    try {
      const user = await bot.helpers.getUser(BigInt(userId));
      await bot.helpers.editChannel(
        BigInt(channelId),
        { name: `自己紹介-${user.username}` },
        "チャンネル名の日次同期",
      );
      updated.push(userId);
    } catch {
      failed.push(userId);
    }
  }

  return { updated, failed };
}

/** 指定ユーザーの現在の自己紹介テキストを取得する(無ければnull)。 */
export async function getBioText(
  bot: ChannelManager,
  db: Database,
  userId: string,
): Promise<string | null> {
  const bioChannel = await getBioChannel(db, userId);
  if (!bioChannel?.lastMessageId) return null;

  try {
    const message = await bot.helpers.getMessage(
      BigInt(bioChannel.channelId),
      BigInt(bioChannel.lastMessageId),
    );
    return message.content;
  } catch {
    return null;
  }
}

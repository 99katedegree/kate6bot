import { ChannelTypes } from "@discordeno/bot";
import type { Database } from "../db.ts";

interface ChannelManager {
  helpers: {
    createChannel: (
      guildId: bigint,
      options: { name: string; type: ChannelTypes; parentId: bigint },
      reason?: string,
    ) => Promise<{ id: bigint }>;
    deleteChannel: (channelId: bigint, reason?: string) => Promise<void>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const pickupCategoryId = BigInt(Deno.env.get("PICKUP_CATEGORY_ID")!);
const PICKUP_VC_NAME = "pickup";

export async function getPickupChannelId(db: Database): Promise<string | null> {
  const result = await db.execute("SELECT channel_id FROM pickup_channel");
  const id = result.rows[0]?.channel_id;
  return id === undefined ? null : String(id);
}

async function setPickupChannelId(db: Database, channelId: string): Promise<void> {
  await db.batch(
    [
      "DELETE FROM pickup_channel",
      { sql: "INSERT INTO pickup_channel (channel_id) VALUES (?)", args: [channelId] },
    ],
    "write",
  );
}

/**
 * 既存のpickup用VCを削除し、新規に作り直す。
 * チャンネルを丸ごと作り直すことで、過去の会話履歴を含めて完全にリセットする。
 * カテゴリーの子チャンネルとして作るので、権限はカテゴリーから自動継承される。
 */
export async function recreatePickupVoiceChannel(
  bot: ChannelManager,
  db: Database,
): Promise<bigint> {
  const existing = await getPickupChannelId(db);
  if (existing) {
    try {
      await bot.helpers.deleteChannel(BigInt(existing), "pickup入れ替えによる再作成");
    } catch {
      // 既に削除されている場合などは無視して新規作成を続ける
    }
  }

  const channel = await bot.helpers.createChannel(
    guildId,
    { name: PICKUP_VC_NAME, type: ChannelTypes.GuildVoice, parentId: pickupCategoryId },
    "pickup入れ替えによる再作成",
  );

  await setPickupChannelId(db, channel.id.toString());
  return channel.id;
}

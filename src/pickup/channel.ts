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
    getChannel: (channelId: bigint) => Promise<unknown>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const pickupCategoryId = BigInt(Deno.env.get("PICKUP_CATEGORY_ID")!);
// Discordのデフォルトと同じ、普通のチャンネル名にする
const PICKUP_VC_NAME = "ボイスチャンネル";
const PICKUP_TEXT_NAME = "テキストチャンネル";

export interface PickupChannels {
  voiceId: bigint;
  textId: bigint;
}

/**
 * botが投稿してよい、pickup用テキストチャンネルのid。
 * pickupのお知らせ・自己紹介などの投稿は、必ずこのチャンネルに送る。
 * VCの内蔵チャットには絶対に投稿しないこと(だからVC側のidはここでは返さない)。
 */
export async function getPickupTextChannelId(db: Database): Promise<string | null> {
  const result = await db.execute("SELECT text_channel_id FROM pickup_channel");
  const id = result.rows[0]?.text_channel_id;
  return id === undefined || id === null ? null : String(id);
}

/** pickup用のテキストチャンネルとVCのid(権限の再適用に使う) */
export async function getPickupChannelIds(db: Database): Promise<bigint[]> {
  return (await getExistingChannelIds(db)).map(BigInt);
}

async function getExistingChannelIds(db: Database): Promise<string[]> {
  const result = await db.execute("SELECT voice_channel_id, text_channel_id FROM pickup_channel");
  const row = result.rows[0];
  if (!row) return [];
  return [row.voice_channel_id, row.text_channel_id]
    .filter((id) => id !== null && id !== undefined)
    .map(String);
}

async function setPickupChannels(db: Database, channels: PickupChannels): Promise<void> {
  await db.batch(
    [
      "DELETE FROM pickup_channel",
      {
        sql: "INSERT INTO pickup_channel (voice_channel_id, text_channel_id) VALUES (?, ?)",
        args: [channels.voiceId.toString(), channels.textId.toString()],
      },
    ],
    "write",
  );
}

/**
 * 既存のpickup用テキストチャンネルとVCを削除し、1つずつ新規に作り直す。
 * チャンネルを丸ごと作り直すことで、過去の会話履歴を含めて完全にリセットする。
 * カテゴリーの子チャンネルとして作るので、権限はカテゴリーから自動継承される。
 */
export async function recreatePickupChannels(
  bot: ChannelManager,
  db: Database,
): Promise<PickupChannels> {
  for (const existing of await getExistingChannelIds(db)) {
    try {
      await bot.helpers.deleteChannel(BigInt(existing), "pickup入れ替えによる再作成");
    } catch {
      // 既に削除されている場合などは無視して新規作成を続ける
    }
  }

  const text = await bot.helpers.createChannel(
    guildId,
    { name: PICKUP_TEXT_NAME, type: ChannelTypes.GuildText, parentId: pickupCategoryId },
    "pickup入れ替えによる再作成",
  );
  const voice = await bot.helpers.createChannel(
    guildId,
    { name: PICKUP_VC_NAME, type: ChannelTypes.GuildVoice, parentId: pickupCategoryId },
    "pickup入れ替えによる再作成",
  );

  const channels = { voiceId: voice.id, textId: text.id };
  await setPickupChannels(db, channels);
  return channels;
}

/**
 * 起動時に呼ぶ。pickup用のテキストチャンネルとVCが揃っていなければ作り直す。
 * (毎日のピックまで待たずに、カテゴリーの中身が常に揃った状態にしておくため)
 * 既に両方あれば何もしない。作り直した場合は true を返す。
 */
export async function ensurePickupChannels(bot: ChannelManager, db: Database): Promise<boolean> {
  const ids = await getExistingChannelIds(db);
  const textId = await getPickupTextChannelId(db);
  if (ids.length === 2 && textId) {
    try {
      for (const id of ids) await bot.helpers.getChannel(BigInt(id));
      return false;
    } catch {
      // どちらかが消えている → 作り直す
    }
  }
  await recreatePickupChannels(bot, db);
  return true;
}

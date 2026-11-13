import type { CreateMessageOptions, FileContent } from "@discordeno/bot";

/** 匿名掲示板の投稿の末尾に付ける区切り線(kate5botと同じ形式) */
export const SEPARATOR = "----------------------------------------------";

/** Discordの1メッセージの上限(2000文字)から、区切り線と改行の分を引いた、本文の上限 */
export const MAX_CONTENT_LENGTH = 2000 - SEPARATOR.length - 2;

/** チャンネルの説明文 */
export const BOARD_TOPIC =
  "botにDMを送ると、名前を出さずにここへ投稿されます。思いやりをもって書き込んでください。";

/** 匿名掲示板に投稿する本文。名前は付けず、本文のあとに区切り線を入れる(本文が無ければ区切り線のみ) */
export function buildBoardPost(content: string): string {
  return content.length > 0 ? `${content}\n\n${SEPARATOR}` : SEPARATOR;
}

/** 転送する画像の上限(1枚あたり8MB、1投稿あたり4枚まで)。Discordのアップロード上限に収める */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 4;

export interface IncomingAttachment {
  url: string;
  filename: string;
  contentType?: string | null;
  size?: number;
}

function isTransferableImage(a: IncomingAttachment): boolean {
  return (a.contentType ?? "").startsWith("image/") && (a.size ?? 0) <= MAX_IMAGE_BYTES;
}

/**
 * 画像を取得して、掲示板に添付し直す(元のURLやファイル名を、そのまま見せないため)。
 * ファイル名は連番に置き換える。画像以外や大きすぎるものは転送しない。
 */
async function downloadImages(attachments: IncomingAttachment[]): Promise<FileContent[]> {
  const files: FileContent[] = [];
  for (const a of attachments.filter(isTransferableImage).slice(0, MAX_IMAGES)) {
    const response = await fetch(a.url);
    if (!response.ok) throw new Error(`画像の取得に失敗しました(HTTP ${response.status})`);
    const ext = a.filename.includes(".") ? a.filename.split(".").pop()!.toLowerCase() : "png";
    files.push({ blob: await response.blob(), name: `image${files.length + 1}.${ext}` });
  }
  return files;
}

interface BoardBot {
  helpers: {
    sendMessage: (
      channelId: bigint,
      options: CreateMessageOptions,
    ) => Promise<{ id: bigint }>;
    getMember: (guildId: bigint, userId: bigint) => Promise<unknown>;
    getChannel: (channelId: bigint) => Promise<{ topic?: string | null }>;
    editChannel: (
      channelId: bigint,
      options: { topic: string },
      reason?: string,
    ) => Promise<unknown>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
export const boardChannelId = BigInt(Deno.env.get("ANONYMOUS_CHANNEL_ID")!);

export type RelayResult =
  | { ok: true; messageId: bigint }
  | { ok: false; reason: "not-member" | "empty" | "too-long" };

/**
 * DMで届いた本文を、匿名で掲示板に投稿する。
 * - サーバーのメンバーからのDMだけを受け付ける
 * - 画像(最大4枚)は取得して添付し直す。画像以外の添付は転送しない
 * - 本文も画像も無い場合や、本文が長すぎる場合は投稿しない
 * - DMの本文に含まれるメンションは、誰にも通知されないようにする
 */
export async function relayToBoard(
  bot: BoardBot,
  authorId: bigint,
  rawContent: string,
  attachments: IncomingAttachment[] = [],
): Promise<RelayResult> {
  try {
    await bot.helpers.getMember(guildId, authorId);
  } catch {
    return { ok: false, reason: "not-member" };
  }

  const content = rawContent.trim();
  if (content.length > MAX_CONTENT_LENGTH) return { ok: false, reason: "too-long" };

  const files = await downloadImages(attachments);
  if (content.length === 0 && files.length === 0) return { ok: false, reason: "empty" };

  const posted = await bot.helpers.sendMessage(boardChannelId, {
    content: buildBoardPost(content),
    allowedMentions: { parse: [] },
    ...(files.length > 0 ? { files } : {}),
  });
  return { ok: true, messageId: posted.id };
}

/** チャンネルの説明文を宣言どおりにそろえる(既にそろっていれば何もしない) */
export async function ensureBoardTopic(bot: BoardBot): Promise<boolean> {
  const channel = await bot.helpers.getChannel(boardChannelId);
  if (channel.topic === BOARD_TOPIC) return false;
  await bot.helpers.editChannel(
    boardChannelId,
    { topic: BOARD_TOPIC },
    "匿名掲示板の説明文を整える",
  );
  return true;
}

/** 管理者向けログに載せる、投稿へのリンク */
export function boardMessageUrl(messageId: bigint): string {
  return `https://discord.com/channels/${guildId}/${boardChannelId}/${messageId}`;
}

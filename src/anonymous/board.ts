import type { CreateMessageOptions, FileContent } from "@discordeno/bot";
import type { Database } from "../db.ts";

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
    editMessage: (
      channelId: bigint,
      messageId: bigint,
      options: { content: string; allowedMentions?: CreateMessageOptions["allowedMentions"] },
    ) => Promise<unknown>;
    deleteMessage: (channelId: bigint, messageId: bigint, reason?: string) => Promise<void>;
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

/** 対応表: DMのメッセージ → 掲示板の投稿 */
export async function savePost(
  db: Database,
  dmMessageId: bigint,
  boardMessageId: bigint,
  authorId: bigint,
  content: string,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT OR REPLACE INTO anonymous_posts (dm_message_id, board_message_id, author_id, content) VALUES (?, ?, ?, ?)",
    args: [dmMessageId.toString(), boardMessageId.toString(), authorId.toString(), content],
  });
}

interface PostRecord {
  boardMessageId: bigint;
  authorId: string;
  content: string;
}

export async function findPostByDmMessage(
  db: Database,
  dmMessageId: bigint,
): Promise<PostRecord | null> {
  const result = await db.execute({
    sql: "SELECT board_message_id, author_id, content FROM anonymous_posts WHERE dm_message_id = ?",
    args: [dmMessageId.toString()],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    boardMessageId: BigInt(String(row.board_message_id)),
    authorId: String(row.author_id),
    content: String(row.content),
  };
}

export async function deletePostRecordByDm(db: Database, dmMessageId: bigint): Promise<void> {
  await db.execute({
    sql: "DELETE FROM anonymous_posts WHERE dm_message_id = ?",
    args: [dmMessageId.toString()],
  });
}

/** 掲示板上で直接削除された投稿の対応を消す */
export async function deletePostRecordByBoard(
  db: Database,
  boardMessageId: bigint,
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM anonymous_posts WHERE board_message_id = ?",
    args: [boardMessageId.toString()],
  });
}

export type EditResult = "edited" | "unchanged" | "too-long" | "no-post";

/**
 * DMのメッセージが編集されたとき、掲示板の投稿の本文を書き換える。文字だけが対象(画像は変わらない)。
 * 本文が最後に反映したものと同じなら(リンクのプレビューなど)、何もしない。
 */
export async function editBoardPost(
  bot: BoardBot,
  db: Database,
  dmMessageId: bigint,
  rawContent: string,
): Promise<EditResult> {
  const post = await findPostByDmMessage(db, dmMessageId);
  if (!post) return "no-post";

  const content = rawContent.trim();
  if (content === post.content) return "unchanged";
  if (content.length > MAX_CONTENT_LENGTH) return "too-long";

  await bot.helpers.editMessage(boardChannelId, post.boardMessageId, {
    content: buildBoardPost(content),
    allowedMentions: { parse: [] },
  });
  await db.execute({
    sql: "UPDATE anonymous_posts SET content = ? WHERE dm_message_id = ?",
    args: [content, dmMessageId.toString()],
  });
  return "edited";
}

/** DMのメッセージが削除されたとき、掲示板の投稿も削除する。対応する投稿が無ければ false。 */
export async function deleteBoardPost(
  bot: BoardBot,
  db: Database,
  dmMessageId: bigint,
): Promise<boolean> {
  const post = await findPostByDmMessage(db, dmMessageId);
  if (!post) return false;
  try {
    await bot.helpers.deleteMessage(
      boardChannelId,
      post.boardMessageId,
      "DMのメッセージが削除されたため",
    );
  } catch {
    // 掲示板で既に削除されている場合などは無視して、対応表だけ消す
  }
  await deletePostRecordByDm(db, dmMessageId);
  return true;
}

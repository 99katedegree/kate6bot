import type { CreateMessageOptions } from "@discordeno/bot";

interface MessageSender {
  helpers: {
    sendMessage: (channelId: bigint, options: CreateMessageOptions) => Promise<unknown>;
  };
}

/** 任意のチャンネルにメッセージを送る汎用関数。log・アナウンス・pickup内リマインドの共通基盤。 */
export async function notify(
  bot: MessageSender,
  channelId: bigint,
  options: string | CreateMessageOptions,
): Promise<void> {
  const payload = typeof options === "string" ? { content: options } : options;
  await bot.helpers.sendMessage(channelId, payload);
}

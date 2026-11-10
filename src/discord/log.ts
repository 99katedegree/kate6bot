import type { CreateMessageOptions } from "@discordeno/bot";
import { notify } from "./notify.ts";

const logChannelId = BigInt(Deno.env.get("LOG_CHANNEL_ID")!);

interface MessageSender {
  helpers: {
    sendMessage: (channelId: bigint, options: CreateMessageOptions) => Promise<unknown>;
  };
}

export function createLogger(bot: MessageSender) {
  return async function log(message: string) {
    console.log(message);
    try {
      await notify(bot, logChannelId, message);
    } catch (error) {
      console.error("Failed to send log message:", error);
    }
  };
}

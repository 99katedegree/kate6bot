import { createBot } from "@discordeno/bot";
import { COMMAND_BIO, COMMAND_TIER } from "../src/commands.ts";

const bot = createBot({ token: Deno.env.get("DISCORD_TOKEN")! });

// 0: サーバーのチャンネル / 1: ボットとのDM / 2: 他のユーザーとのDM・グループDM
const CONTEXTS = [0, 1, 2] as const;
// 0: サーバーへのインストール / 1: ユーザーインストール(サーバーが無くても、自分のアカウントに追加して使える)
const INTEGRATION_TYPES = [0, 1] as const;

await bot.helpers.upsertGlobalApplicationCommands([
  {
    name: COMMAND_TIER,
    description: "あなたの段位を設定します",
    contexts: [...CONTEXTS],
    integrationTypes: [...INTEGRATION_TYPES],
  },
  {
    name: COMMAND_BIO,
    description: "あなたの自己紹介を書いたり、書き直したりします",
    contexts: [...CONTEXTS],
    integrationTypes: [...INTEGRATION_TYPES],
  },
]);

console.log(`Registered global commands: /${COMMAND_TIER}, /${COMMAND_BIO}`);

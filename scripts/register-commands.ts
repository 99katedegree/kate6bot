import { createBot } from "@discordeno/bot";

const bot = createBot({ token: Deno.env.get("DISCORD_TOKEN")! });
const guildId = BigInt(Deno.env.get("GUILD_ID")!);

await bot.helpers.upsertGuildApplicationCommands(guildId, [
  {
    name: "段位",
    description: "あなたにしか見えない形で段位を設定します",
  },
]);

console.log("Registered /段位 command.");

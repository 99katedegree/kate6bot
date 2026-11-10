import { createBot } from "@discordeno/bot";

const guildId = BigInt(Deno.env.get("GUILD_ID")!);

const bot = createBot({
  token: Deno.env.get("DISCORD_TOKEN")!,
  desiredProperties: {
    role: { permissions: true, name: true },
  },
});

// @everyone ロールのidはギルドidと常に同一
const everyoneRole = await bot.helpers.getRole(guildId, guildId);

const dangerousPermissions = [
  "MANAGE_ROLES",
  "ADMINISTRATOR",
  "MANAGE_GUILD",
  "MANAGE_CHANNELS",
] as const;

console.log(`@everyone ロール(${everyoneRole.name})の危険な権限チェック:`);
for (const permission of dangerousPermissions) {
  const has = everyoneRole.permissions.has(permission);
  console.log(`  ${permission}: ${has ? "⚠️ 持っている" : "OK: 持っていない"}`);
}

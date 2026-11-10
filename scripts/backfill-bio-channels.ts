import { createBot } from "@discordeno/bot";
import { openDatabase } from "../src/db.ts";
import { ensureBioChannel } from "../src/profile/bio.ts";

const db = await openDatabase();
const guildId = BigInt(Deno.env.get("GUILD_ID")!);

const bot = createBot({
  token: Deno.env.get("DISCORD_TOKEN")!,
  desiredProperties: {
    user: { id: true, username: true, toggles: true },
    member: { user: true },
    channel: { id: true },
    message: { content: true },
  },
});

const members = await bot.helpers.getMembers(guildId, { limit: 1000 });

for (const member of members) {
  if (member.user?.bot) continue;

  const userId = member.user!.id.toString();
  const channelId = await ensureBioChannel(bot, db, userId, member.user!.username);
  console.log(`Ensured bio channel for ${userId}: ${channelId}`);
}

console.log(`Done. Checked ${members.length} members.`);

import {
  ButtonStyles,
  createBot,
  GatewayIntents,
  type InteractionCallbackData,
  InteractionTypes,
  MessageComponentTypes,
} from "@discordeno/bot";
import { createLogger } from "./discord/log.ts";
import { notify } from "./discord/notify.ts";
import { respondPrivately } from "./discord/respond.ts";
import { openDatabase } from "./db.ts";
import { applyManagedPermissions } from "./permissions.ts";
import {
  forceDisconnectFromVoice,
  getCurrentPickupHolders,
  grantPickupRole,
  revokePickupRole,
} from "./pickup/role.ts";
import { getPickupChannelId, recreatePickupVoiceChannel } from "./pickup/channel.ts";
import { pickGroup } from "./pickup/pick.ts";
import { buildPool } from "./pickup/pool.ts";
import { isSkipped, setSkip } from "./pickup/skip.ts";
import {
  ensureBioChannel,
  findBioChannelOwner,
  getBioText,
  replaceBioMessage,
  syncBioChannelNames,
} from "./profile/bio.ts";
import { jstDateString, upcomingMonday } from "./schedule.ts";
import { clearTier, getTier, setTier } from "./tier/members.ts";
import { extractTierFromRoles, isTier, isTopTier, TIER_ROLE_IDS, TIERS } from "./tier/tiers.ts";

const db = await openDatabase();
const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const ownerUserId = Deno.env.get("OWNER_USER_ID")!;
const announceChannelId = BigInt(Deno.env.get("ANNOUNCE_CHANNEL_ID")!);

const TIER_SELECT_CUSTOM_ID = "tier_select";
const OPEN_TIER_SELECT_BUTTON = "open_tier_select";
const SKIP_WEEK_PREFIX = "skip_week:";

function tierSelectMessage(): InteractionCallbackData {
  return {
    content: "あなたにしか見えない形で段位を設定できます。下から選んでください。",
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.SelectMenu,
            customId: TIER_SELECT_CUSTOM_ID,
            placeholder: "段位を選択",
            options: TIERS.map((tier) => ({ label: tier, value: tier })),
          },
        ],
      },
    ],
  };
}

const bot = createBot({
  token: Deno.env.get("DISCORD_TOKEN")!,
  intents: GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.GuildMembers,
  desiredProperties: {
    user: { id: true, username: true },
    message: { id: true, content: true, channelId: true },
    channel: { id: true },
    member: { roles: true },
    interaction: {
      id: true,
      token: true,
      type: true,
      data: true,
      guildId: true,
      user: true,
    },
  },
  events: {
    ready: async ({ shardId, user }) => {
      await log(`Shard ${shardId} ready as ${user.username}`);
      await applyManagedPermissions(bot, log);
    },
    interactionCreate: async (interaction) => {
      if (
        interaction.type === InteractionTypes.ApplicationCommand &&
        interaction.data?.name === "段位"
      ) {
        await log(`/段位 コマンドが実行されました(user=${interaction.user?.id})`);
        await respondPrivately(interaction, tierSelectMessage());
        await log(`段位選択メニューを表示しました(user=${interaction.user?.id})`);
        return;
      }

      if (
        interaction.type === InteractionTypes.MessageComponent &&
        interaction.data?.customId === OPEN_TIER_SELECT_BUTTON
      ) {
        await log(
          `リマインドの「段位を設定する」ボタンが押されました(user=${interaction.user?.id})`,
        );
        await respondPrivately(interaction, tierSelectMessage());
        await log(`段位選択メニューを表示しました(user=${interaction.user?.id})`);
        return;
      }

      if (
        interaction.type === InteractionTypes.MessageComponent &&
        interaction.data?.customId === TIER_SELECT_CUSTOM_ID
      ) {
        const selected = interaction.data.values?.[0];
        if (!selected || !isTier(selected)) {
          await log(
            `段位選択メニューの値が不正でした(user=${interaction.user?.id}, values=${
              JSON.stringify(interaction.data.values)
            })`,
          );
          return;
        }

        const userId = interaction.user!.id;
        const previousTier = await getTier(db, userId.toString());
        await log(
          `段位選択を受信(user=${userId}, 旧段位=${previousTier ?? "未設定"}, 新段位=${selected})`,
        );

        try {
          if (previousTier && previousTier !== selected) {
            await bot.helpers.removeRole(
              guildId,
              userId,
              TIER_ROLE_IDS[previousTier],
              "段位更新",
            );
            await log(`旧段位ロール「${previousTier}」を剥奪しました(user=${userId})`);
          }
          if (previousTier !== selected) {
            await bot.helpers.addRole(
              guildId,
              userId,
              TIER_ROLE_IDS[selected],
              "段位更新",
            );
            await log(`新段位ロール「${selected}」を付与しました(user=${userId})`);
          }
        } catch (error) {
          await log(
            `段位ロールの更新に失敗しました(user=${userId}, tier=${selected}): ${error}`,
          );
          await respondPrivately(
            interaction,
            "段位の更新に失敗しました。管理者に連絡してください。",
          );
          return;
        }

        await setTier(db, userId.toString(), selected);
        await log(`DBのtierを更新しました(user=${userId}, tier=${selected})`);

        const note = isTopTier(selected)
          ? "(この段位は2人パーティ制限があるため、週次ピックは1人のみになります)"
          : "";
        await respondPrivately(interaction, `段位を「${selected}」に設定しました。${note}`);
        return;
      }

      if (
        interaction.type === InteractionTypes.MessageComponent &&
        interaction.data?.customId?.startsWith(SKIP_WEEK_PREFIX)
      ) {
        const weekOf = interaction.data.customId.slice(SKIP_WEEK_PREFIX.length);
        const userId = interaction.user!.id.toString();
        await log(`「今週は参加しない」ボタンが押されました(user=${userId}, week=${weekOf})`);
        await setSkip(db, userId, weekOf);
        await log(`weekly_skipに記録しました(user=${userId}, week=${weekOf})`);
        await respondPrivately(interaction, `${weekOf}の週は参加しない設定にしました。`);
        return;
      }
    },
    guildMemberAdd: async (_member, user) => {
      const userId = user.id.toString();
      await log(`新規メンバーが参加しました(user=${userId}, username=${user.username})`);

      const channelId = await ensureBioChannel(bot, db, userId, user.username);
      await log(`自己紹介チャンネルを用意しました(user=${userId}, channel=${channelId})`);

      try {
        const dmChannel = await bot.helpers.getDmChannel(user.id);
        await notify(
          bot,
          dmChannel.id,
          `ここはあなた専用の自己紹介チャンネルです: <#${channelId}>\n自由に自己紹介を投稿してください。(新しく投稿すると、前回の内容は自動で削除され最新の投稿だけが使われます。pickでピックされた人にだけ公開されます)`,
        );
        await log(`案内をDMで送信しました(user=${userId})`);
      } catch (error) {
        await log(`DM送信に失敗しました(user=${userId}): ${error}`);
      }
    },
    guildMemberUpdate: async (member, user) => {
      const userId = user.id.toString();
      const { tier: roleTier, hasConflict } = extractTierFromRoles(member.roles);

      if (hasConflict) {
        await log(
          `警告: 複数の段位ロールを同時に保持しています(user=${userId})。先頭の段位を採用します。`,
        );
      }

      const dbTier = await getTier(db, userId);
      if (roleTier === dbTier) return;

      // ロールが常に正。DBとズレていたらロールに合わせてDBを修正する
      if (roleTier) {
        await setTier(db, userId, roleTier);
        await log(
          `ロールとDBのズレを検知し修正しました(user=${userId}, DB=${
            dbTier ?? "未設定"
          } → ロール基準=${roleTier})`,
        );
      } else {
        await clearTier(db, userId);
        await log(
          `ロールとDBのズレを検知し修正しました(user=${userId}, DB=${dbTier} → ロール基準=未設定)`,
        );
      }
    },
    messageCreate: async (message) => {
      const owner = await findBioChannelOwner(db, message.channelId.toString());
      if (!owner) return;

      await log(`自己紹介チャンネルに新規投稿を検知しました(user=${owner})`);
      await replaceBioMessage(bot, db, owner, message.channelId, message.id);
      await log(`自己紹介を最新の内容に更新しました(user=${owner})`);
    },
  },
});

const log = createLogger(bot);

// [tier-reminder] 木曜 20:00 JST(=11:00 UTC)
Deno.cron("tier-reminder", "0 11 * * 4", async () => {
  await log("段位確認リマインドのcronを開始します");
  const weekOf = upcomingMonday(new Date());
  await log(`対象週を計算しました: ${weekOf}`);
  await notify(bot, announceChannelId, {
    content: "段位は変わりましたか？ボタンを押すと、あなたにしか見えない形で確認・設定できます。",
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.Button,
            style: ButtonStyles.Primary,
            label: "段位を設定する",
            customId: OPEN_TIER_SELECT_BUTTON,
          },
          {
            type: MessageComponentTypes.Button,
            style: ButtonStyles.Secondary,
            label: "今週は参加しない",
            customId: `${SKIP_WEEK_PREFIX}${weekOf}`,
          },
        ],
      },
    ],
  });
  await log(`段位確認リマインドを送信しました(対象週: ${weekOf})`);
});

// 月曜 0:00 JST(=前日15:00 UTC)
Deno.cron("weekly-pick", "0 15 * * 0", async () => {
  await log("週次ランダムピックのcronを開始します");
  const weekOf = jstDateString(new Date());
  await log(`対象週を計算しました: ${weekOf}`);

  const revoked = await revokePickupRole(bot, db);
  await log(`前回のpickupロールを剥奪しました(対象: ${revoked.join(", ") || "なし"})`);

  const pickupChannelId = await recreatePickupVoiceChannel(bot, db);
  await log(`pickup用VCを作り直しました(新チャンネルid=${pickupChannelId})`);

  const ownerTier = await getTier(db, ownerUserId);
  await log(`自分の段位を取得しました(user=${ownerUserId}, tier=${ownerTier ?? "未設定"})`);

  if (!ownerTier) {
    await log(`週次ピック不成立: 自分(${ownerUserId})の段位が未設定`);
    return;
  }

  if (await isSkipped(db, ownerUserId, weekOf)) {
    await log(`週次ピック見送り: 自分(${ownerUserId})が今週は参加しない設定`);
    return;
  }

  const pool = await buildPool(db, ownerUserId, ownerTier, weekOf);
  await log(`プールを構築しました(週=${weekOf}, 人数=${pool.length}, members=${pool.join(", ")})`);

  const result = await pickGroup(db, ownerTier, pool);

  if (!result) {
    await log(`週次ピック不成立(対象週: ${weekOf}, プール: ${pool.length}人)`);
    await notify(bot, announceChannelId, `今週(${weekOf})は候補が足りず不成立でした。`);
    await log("不成立メッセージをアナウンスチャンネルに送信しました");
    return;
  }

  await log(`ピックが成立しました(対象週: ${weekOf}): ${result.selected.join(", ")}`);

  const newHolders = [ownerUserId, ...result.selected];
  await grantPickupRole(bot, db, newHolders);
  await log(`pickupロールを付与しました(対象: ${newHolders.join(", ")})`);

  const mentions = result.selected.map((id) => `<@${id}>`).join(" ");
  await notify(
    bot,
    announceChannelId,
    `今週(${weekOf})は <@${ownerUserId}> と ${mentions} で遊びます！21:00頃を目安に <#${pickupChannelId}> へどうぞ(時間は前後してOKです)。`,
  );
  await log("ピック結果をアナウンスチャンネルに送信しました");

  for (const userId of newHolders) {
    const bio = await getBioText(bot, db, userId);
    if (!bio) {
      await log(`自己紹介が未設定のためスキップしました(user=${userId})`);
      continue;
    }
    await notify(bot, pickupChannelId, `🙋 <@${userId}> の自己紹介:\n${bio}`);
    await log(`自己紹介をpickup用VCに投稿しました(user=${userId})`);
  }
});

// 月曜 21:00 JST(=12:00 UTC): 開始目安のリマインド
Deno.cron("pickup-start-reminder", "0 12 * * 1", async () => {
  const holders = await getCurrentPickupHolders(db);
  const pickupChannelId = await getPickupChannelId(db);
  if (holders.length === 0 || !pickupChannelId) {
    await log("pickup開始リマインド: 今週は対象者がいないためスキップ");
    return;
  }
  await notify(
    bot,
    BigInt(pickupChannelId),
    "21:00になりました。開始の目安の時間です(前後してOKです)。",
  );
  await log("pickup開始リマインドを送信しました");
});

// 月曜 22:15 JST(=13:15 UTC): 終了15分前の警告
Deno.cron("pickup-end-warning", "15 13 * * 1", async () => {
  const holders = await getCurrentPickupHolders(db);
  const pickupChannelId = await getPickupChannelId(db);
  if (holders.length === 0 || !pickupChannelId) {
    await log("pickup終了警告: 今週は対象者がいないためスキップ");
    return;
  }
  await notify(
    bot,
    BigInt(pickupChannelId),
    "22:15になりました。22:30にこのVCは終了(強制退出)しますのでご注意ください。",
  );
  await log("pickup終了警告を送信しました");
});

// 月曜 22:30 JST(=13:30 UTC): 何があってもクリーンアップ
Deno.cron("pickup-cleanup", "30 13 * * 1", async () => {
  await log("pickupクリーンアップのcronを開始します");

  const holders = await getCurrentPickupHolders(db);
  const pickupChannelId = await getPickupChannelId(db);

  if (pickupChannelId) {
    await notify(
      bot,
      BigInt(pickupChannelId),
      "22:30になりました。お疲れ様でした！このVCは終了します。",
    );
    await log("終了メッセージをpickup用VCに送信しました");
  }

  const { succeeded, skipped } = await forceDisconnectFromVoice(bot, holders);
  await log(
    `VCから強制退出させました(成功: ${succeeded.join(", ") || "なし"}, 対象外: ${
      skipped.join(", ") || "なし"
    })`,
  );

  const revoked = await revokePickupRole(bot, db);
  await log(`pickupロールを剥奪しました(対象: ${revoked.join(", ") || "なし"})`);

  await recreatePickupVoiceChannel(bot, db);
  await log("pickup用VCをクリーンな状態に作り直しました");
});

// 毎日 3:00 JST(=前日18:00 UTC): 自己紹介チャンネル名をDiscordのユーザー名に同期
Deno.cron("bio-channel-name-sync", "0 18 * * *", async () => {
  await log("自己紹介チャンネル名の同期cronを開始します");
  const { updated, failed } = await syncBioChannelNames(bot, db);
  await log(
    `自己紹介チャンネル名を同期しました(成功: ${updated.length}件, 失敗: ${
      failed.join(", ") || "なし"
    })`,
  );
});

await bot.start();

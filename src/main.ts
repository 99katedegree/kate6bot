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
import { applyManagedPermissions, applyPickupChildPermissions } from "./permissions.ts";
import {
  forceDisconnectFromVoice,
  getCurrentPickupHolders,
  grantPickupRole,
  revokePickupRole,
} from "./pickup/role.ts";
import {
  ensurePickupChannels,
  getPickupChannelIds,
  getPickupTextChannelId,
  recreatePickupChannels,
} from "./pickup/channel.ts";
import { pickGroup } from "./pickup/pick.ts";
import { buildPool } from "./pickup/pool.ts";
import { isSkipped, setSkip } from "./pickup/skip.ts";
import {
  displayName,
  ensureBioChannel,
  findBioChannelOwner,
  getBioText,
  replaceBioMessage,
  syncBioChannelNames,
} from "./profile/bio.ts";
import { reconcileBioChannels } from "./profile/reconcile.ts";
import { jstDateString, upcomingMonday, weekStartMonday } from "./schedule.ts";
import { clearTier, getTier, setTier } from "./tier/members.ts";
import {
  extractTierFromRoles,
  isTier,
  isTopTier,
  TIER_ROLE_IDS,
  tierLabel,
  TIERS,
} from "./tier/tiers.ts";

const db = await openDatabase();
const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const ownerUserId = Deno.env.get("OWNER_USER_ID")!;
const announceChannelId = BigInt(Deno.env.get("ANNOUNCE_CHANNEL_ID")!);

const TIER_SELECT_CUSTOM_ID = "tier_select";
const OPEN_TIER_SELECT_BUTTON = "open_tier_select";
const SKIP_WEEK_PREFIX = "skip_week:";

function tierSelectMessage(
  content = "今の段位を選んでみて！他の人には見えないので、気軽にどうぞ",
): InteractionCallbackData {
  return {
    content,
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.SelectMenu,
            customId: TIER_SELECT_CUSTOM_ID,
            placeholder: "段位を選択",
            options: TIERS.map((tier) => ({ label: tierLabel(tier), value: tier })),
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
    user: { id: true, username: true, globalName: true, toggles: true },
    message: { id: true, content: true, channelId: true },
    channel: { id: true, parentId: true },
    member: { roles: true, user: true, nick: true },
    guild: { id: true, name: true },
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
      await runMaintenance();
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
            "ごめんなさい、段位の更新に失敗しました。管理者に連絡してください。",
          );
          return;
        }

        await setTier(db, userId.toString(), selected);
        await log(`DBのtierを更新しました(user=${userId}, tier=${selected})`);

        const note = isTopTier(selected)
          ? "(この段位は2人パーティ制限があるため、ピックは1人のみになります)"
          : "";
        await respondPrivately(
          interaction,
          `段位を「${tierLabel(selected)}」に設定しました！${note}`,
        );
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
        await respondPrivately(
          interaction,
          `${weekOf}の週は、お休みにしておきました。また来週お待ちしています！`,
        );
        return;
      }
    },
    guildMemberAdd: async (member, user) => {
      const userId = user.id.toString();
      await log(`新規メンバーが参加しました(user=${userId}, username=${user.username})`);

      const channelId = await ensureBioChannel(
        bot,
        db,
        userId,
        displayName({ nick: member.nick, user }),
      );
      await log(`自己紹介チャンネルを用意しました(user=${userId}, channel=${channelId})`);

      try {
        const dmChannel = await bot.helpers.getDmChannel(user.id);
        // DMにはどのサーバーからの連絡か分からないので、サーバー名を明記する
        const guildName = await bot.helpers.getGuild(guildId).then((g) => g.name).catch(() => null);
        await notify(
          bot,
          dmChannel.id,
          [
            `${guildName ? `「${guildName}」` : "サーバー"}へようこそ！`,
            "平日(月〜金)は毎日、私がその日に一緒に遊ぶメンバーを選びます！",
            "また、あなた専用の自己紹介チャンネルを作ったので、ぜひ自己紹介を投稿してください！",
            `https://discord.com/channels/${guildId}/${channelId}`,
            "投稿した自己紹介は、一緒に遊ぶときに自動で共有されます。何度でも投稿し直せて、使われるのは最新の1件だけです。",
          ].join("\n"),
        );
        await log(`案内をDMで送信しました(user=${userId})`);

        // 段位は選択肢から選ぶだけ。選択後は /段位 と同じ処理でロールが付与される
        await notify(
          bot,
          dmChannel.id,
          tierSelectMessage(
            "最後に、あなたの段位を下から選んでください。あとから変えたいときは、/段位 でいつでも変更できます。",
          ),
        );
        await log(`段位選択メニューをDMで送信しました(user=${userId})`);
      } catch (error) {
        // DMを閉じている人には送れない。自己紹介チャンネルは作成済みなので、ここでは記録のみ行う
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

/**
 * 起動時と毎日3:00(JST)に同じ内容を実行する保守処理。
 * 起動しなかった期間があっても、毎日のバッチで必ず状態が整う。
 * - 管理対象の権限設定の再適用
 * - pickup用のテキストチャンネル/VCが揃っているかの確認(無ければ作成)と、その権限の再適用
 * - 自己紹介チャンネルの差分修復と、チャンネル名・権限の同期
 */
async function runMaintenance(): Promise<void> {
  await applyManagedPermissions(bot, log);
  try {
    const created = await ensurePickupChannels(bot, db);
    await log(
      created
        ? "pickup用のテキストチャンネルとVCが揃っていなかったため作成しました"
        : "pickup用のテキストチャンネルとVCは揃っています",
    );
  } catch (error) {
    await log(`pickup用チャンネルの確認に失敗しました: ${error}`);
  }
  await applyPickupChildPermissions(bot, await getPickupChannelIds(db), log);
  await runBioReconcile();
}

/** メンバーと自己紹介チャンネルの差分修復と、チャンネル名の表示名への同期を行う*/
async function runBioReconcile(): Promise<void> {
  await log("自己紹介チャンネルの差分チェックを開始します");
  try {
    const r = await reconcileBioChannels(bot, db);
    const list = (ids: string[]) => ids.length > 0 ? ` [${ids.join(", ")}]` : "";
    await log(
      `自己紹介チャンネルの差分チェック完了(メンバー${r.memberCount}人): ` +
        `新規作成${r.created.length}件${list(r.created)}, ` +
        `作り直し${r.recreated.length}件${list(r.recreated)}, ` +
        `削除${r.removed.length}件${list(r.removed)}, ` +
        `失敗${r.failed.length}件${list(r.failed)}`,
    );
    if (r.removalSkipped.length > 0) {
      await log(
        `警告: サーバーを抜けた人が${r.removalSkipped.length}人と多いため、安全のため削除を見送りました。メンバー取得の異常でないか確認してください:${
          list(r.removalSkipped)
        }`,
      );
    }
    if (r.untrackedChannels.length > 0) {
      await log(
        `警告: profileカテゴリー配下にDBと紐付かないチャンネルがあります(自動では削除しません):${
          r.untrackedChannels.map((id) => `<#${id}>`).join(" ")
        }`,
      );
    }
  } catch (error) {
    await log(`自己紹介チャンネルの差分チェックに失敗しました: ${error}`);
  }

  const { updated, failed } = await syncBioChannelNames(bot, db);
  await log(
    `自己紹介チャンネル名を表示名に同期しました(成功: ${updated.length}件, 失敗: ${
      failed.join(", ") || "なし"
    })`,
  );
}

// 木曜 20:00 JST(=11:00 UTC): 翌週の段位確認と「今週は参加しない」の受付
Deno.cron("tier-reminder", "0 11 * * 4", async () => {
  await log("段位確認リマインドのcronを開始します");
  const weekOf = upcomingMonday(new Date());
  await log(`対象週を計算しました: ${weekOf}`);
  await notify(bot, announceChannelId, {
    content: "段位は変わりましたか？下のボタンから、自分だけに見える形で確認・変更できます。",
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

// 月〜金 0:00 JST(=前日 日〜木 15:00 UTC)
Deno.cron("daily-pick", "0 15 * * SUN-THU", async () => {
  await log("ランダムピックのcronを開始します");
  const now = new Date();
  const today = jstDateString(now);
  // 「参加しない」は週単位なので、今日が属する週の月曜日で照合する
  const weekOf = weekStartMonday(now);
  await log(`対象日を計算しました: ${today}(対象週: ${weekOf})`);

  const revoked = await revokePickupRole(bot, db);
  await log(`前回のpickupロールを剥奪しました(対象: ${revoked.join(", ") || "なし"})`);

  const pickupChannels = await recreatePickupChannels(bot, db);
  await log(
    `pickup用のテキストチャンネルとVCを作り直しました(text=${pickupChannels.textId}, voice=${pickupChannels.voiceId})`,
  );

  const ownerTier = await getTier(db, ownerUserId);
  await log(`自分の段位を取得しました(user=${ownerUserId}, tier=${ownerTier ?? "未設定"})`);

  if (!ownerTier) {
    await log(`ピック不成立: 自分(${ownerUserId})の段位が未設定`);
    return;
  }

  if (await isSkipped(db, ownerUserId, weekOf)) {
    await log(`ピック見送り: 自分(${ownerUserId})が今週は参加しない設定`);
    return;
  }

  const pool = await buildPool(db, ownerUserId, ownerTier, weekOf);
  await log(
    `プールを構築しました(日=${today}, 週=${weekOf}, 人数=${pool.length}, members=${
      pool.join(", ")
    })`,
  );

  const result = await pickGroup(db, ownerTier, pool);

  if (!result) {
    await log(`ピック不成立(対象日: ${today}, プール: ${pool.length}人)`);
    await notify(
      bot,
      announceChannelId,
      `今日は人数が足りず、ピックアップできませんでした。`,
    );
    await log("不成立メッセージをアナウンスチャンネルに送信しました");
    return;
  }

  await log(`ピックが成立しました(対象日: ${today}): ${result.selected.join(", ")}`);

  const newHolders = [ownerUserId, ...result.selected];
  await grantPickupRole(bot, db, newHolders);
  await log(`pickupロールを付与しました(対象: ${newHolders.join(", ")})`);

  const mentions = result.selected.map((id) => `<@${id}>`).join(" ");
  await notify(
    bot,
    announceChannelId,
    `今日は <@${ownerUserId}> と ${mentions} をピックアップしました！`,
  );
  await log("ピック結果をアナウンスチャンネルに送信しました");

  for (const userId of newHolders) {
    const bio = await getBioText(bot, db, userId);
    if (!bio) {
      await log(`自己紹介が未設定のためスキップしました(user=${userId})`);
      continue;
    }
    await notify(bot, pickupChannels.textId, `<@${userId}> の自己紹介\n\n${bio}`);
    await log(`自己紹介をpickup用テキストチャンネルに投稿しました(user=${userId})`);
  }
});

// 月〜金 22:15 JST(=13:15 UTC): 終了15分前の警告
Deno.cron("pickup-end-warning", "15 13 * * MON-FRI", async () => {
  const holders = await getCurrentPickupHolders(db);
  const pickupTextChannelId = await getPickupTextChannelId(db);
  if (holders.length === 0 || !pickupTextChannelId) {
    await log("pickup終了警告: 今日は対象者がいないためスキップ");
    return;
  }
  await notify(
    bot,
    BigInt(pickupTextChannelId),
    "22:15です。22:30にVCが終了して、自動で退出になります。",
  );
  await log("pickup終了警告を送信しました");
});

// 月〜金 22:30 JST(=13:30 UTC): 何があってもクリーンアップ
Deno.cron("pickup-cleanup", "30 13 * * MON-FRI", async () => {
  await log("pickupクリーンアップのcronを開始します");

  const holders = await getCurrentPickupHolders(db);
  const pickupTextChannelId = await getPickupTextChannelId(db);

  if (pickupTextChannelId) {
    await notify(
      bot,
      BigInt(pickupTextChannelId),
      "22:30です。お疲れさまでした！VCを終了します。",
    );
    await log("終了メッセージをpickup用テキストチャンネルに送信しました");
  }

  const { succeeded, skipped } = await forceDisconnectFromVoice(bot, holders);
  await log(
    `VCから強制退出させました(成功: ${succeeded.join(", ") || "なし"}, 対象外: ${
      skipped.join(", ") || "なし"
    })`,
  );

  const revoked = await revokePickupRole(bot, db);
  await log(`pickupロールを剥奪しました(対象: ${revoked.join(", ") || "なし"})`);

  await recreatePickupChannels(bot, db);
  await log("pickup用のテキストチャンネルとVCをクリーンな状態に作り直しました");
});

// 毎日 3:00 JST(=前日18:00 UTC): 起動時と同じ保守処理(権限・pickupチャンネル・自己紹介チャンネル)
Deno.cron("daily-maintenance", "0 18 * * *", async () => {
  await runMaintenance();
});

await bot.start();

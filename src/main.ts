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
import { describeError, explainDiscordError } from "./errors.ts";
import {
  cleanupWelcomeChannels,
  deleteWelcomeChannel,
  ensureWelcomeChannel,
  getWelcomeChannel,
} from "./welcome/channel.ts";
import {
  boardChannelId,
  boardMessageUrl,
  deleteBoardPost,
  deletePostRecordByBoard,
  editBoardPost,
  ensureBoardTopic,
  type IncomingAttachment,
  relayToBoard,
  savePost,
} from "./anonymous/board.ts";
import { applyGuildSettings, applyInviteSettings } from "./guild-settings.ts";
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
  getBioChannel,
  getBioText,
  replaceBioMessage,
  syncBioChannelNames,
} from "./profile/bio.ts";
import { fetchAllMembers, reconcileBioChannels } from "./profile/reconcile.ts";
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
  intents: GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.GuildMembers |
    GatewayIntents.DirectMessages | GatewayIntents.MessageContent,
  desiredProperties: {
    user: { id: true, username: true, globalName: true, toggles: true },
    message: {
      id: true,
      content: true,
      channelId: true,
      guildId: true,
      author: true,
      attachments: true,
    },
    channel: { id: true, parentId: true, topic: true },
    attachment: { id: true, url: true, filename: true, contentType: true, size: true },
    member: { roles: true, user: true, nick: true },
    guild: { id: true, name: true, systemChannelId: true, systemChannelFlags: true },
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
            `段位ロールの更新に失敗しました(user=${userId}, tier=${selected}): ${
              describeError(error)
            }`,
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

        // ウェルカム用チャンネルでの設定だったら、返信を読む時間を置いてから、そのチャンネルを閉じる
        await closeWelcomeChannelLater(userId.toString());
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

      await provideWelcome(userId, displayName({ nick: member.nick, user }), channelId);
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
        await closeWelcomeChannelLater(userId);
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
    // DMのメッセージが編集されたら、掲示板の投稿も書き換える(文字のみ)
    messageUpdate: async (message) => {
      if (message.guildId || message.content === undefined) return;
      try {
        const result = await editBoardPost(bot, db, message.id, message.content);
        if (result === "edited") {
          await log(
            `匿名掲示板の投稿を、DMの編集に合わせて書き換えました(user=${message.author?.id})`,
          );
        } else if (result === "too-long") {
          await log(
            `DMの編集後の本文が長すぎるため、匿名掲示板の投稿は書き換えませんでした(user=${message.author?.id})`,
          );
        }
      } catch (error) {
        await log(`匿名掲示板の投稿の書き換えに失敗しました: ${describeError(error)}`);
      }
    },
    messageDelete: async (payload) => {
      try {
        if (payload.guildId) {
          // 掲示板で直接削除された投稿は、対応表からも消す
          if (payload.channelId === boardChannelId) await deletePostRecordByBoard(db, payload.id);
          return;
        }
        // DMのメッセージが削除されたら、掲示板の投稿も削除する
        if (await deleteBoardPost(bot, db, payload.id)) {
          await log("匿名掲示板の投稿を、DMの削除に合わせて削除しました");
        }
      } catch (error) {
        await log(`匿名掲示板の投稿の削除に失敗しました: ${describeError(error)}`);
      }
    },
    messageCreate: async (message) => {
      // botの案内メッセージなどを、自己紹介として扱わない
      if (message.author?.bot) return;

      // サーバー外(DM)で届いたメッセージは、匿名掲示板への投稿として扱う
      if (!message.guildId) {
        await handleDirectMessage(message);
        return;
      }

      const owner = await findBioChannelOwner(db, message.channelId.toString());
      if (!owner) return;

      await log(`自己紹介チャンネルに新規投稿を検知しました(user=${owner})`);
      await replaceBioMessage(bot, db, owner, message.channelId, message.id);
      await log(`自己紹介を最新の内容に更新しました(user=${owner})`);
      await closeWelcomeChannelLater(owner);
    },
  },
});

const log = createLogger(bot);

/**
 * botに届いたDMを、匿名掲示板に投稿する。投稿者は管理者向けログ(運用通知)に残す。
 * DMには一切返信しない(受け付けなかった場合も、ログに残すだけ)。
 */
async function handleDirectMessage(message: {
  id: bigint;
  content?: string;
  attachments?: IncomingAttachment[];
  author?: { id: bigint; username: string };
}): Promise<void> {
  const authorId = message.author?.id;
  if (!authorId) return;

  try {
    const result = await relayToBoard(
      bot,
      authorId,
      message.content ?? "",
      message.attachments ?? [],
    );
    if (!result.ok) {
      await log(
        `匿名掲示板への投稿を受け付けませんでした(user=${authorId}, 理由=${result.reason})`,
      );
      return;
    }

    // DMの編集・削除を掲示板の投稿へ反映できるよう、対応を記録する
    await savePost(db, message.id, result.messageId, authorId, (message.content ?? "").trim());

    // 掲示板には名前を出さない。管理者だけが確認できるよう、運用通知に投稿者と投稿へのリンクを残す
    await log(
      `匿名掲示板に投稿されました(投稿者=<@${authorId}> ${message.author?.username}, 投稿=${
        boardMessageUrl(result.messageId)
      })`,
    );
  } catch (error) {
    await log(`匿名掲示板への投稿に失敗しました(user=${authorId}): ${describeError(error)}`);
  }
}

/** 入室時の案内が完了したか。「段位を選んでいる」かつ「自己紹介が投稿されている」 */
async function isOnboardingComplete(userId: string): Promise<boolean> {
  if (await getTier(db, userId) === null) return false;
  return (await getBioChannel(db, userId))?.lastMessageId != null;
}

/**
 * 本人にしか見えないウェルカム用チャンネルを用意して、案内と段位メニューを送る(DMを受け付けない設定の人にも届く)。
 * 既にあるチャンネルには案内を送り済みなので、何もしない。
 * 作ったのに案内の送信に失敗した場合は、次回やり直せるようにチャンネルごと削除する。
 */
async function provideWelcome(
  userId: string,
  name: string,
  bioChannelId: bigint,
): Promise<void> {
  let step = "ウェルカム用チャンネルの作成";
  let createdChannel = false;
  try {
    const { id: welcomeChannelId, created } = await ensureWelcomeChannel(bot, db, userId, name);
    if (!created) return;
    createdChannel = true;
    await log(`ウェルカム用チャンネルを作成しました(user=${userId}, channel=${welcomeChannelId})`);

    step = "案内メッセージの送信";
    const guildName = await bot.helpers.getGuild(guildId).then((g) => g.name).catch(() => null);
    await notify(
      bot,
      welcomeChannelId,
      [
        "## ようこそ",
        `<@${userId}> ${guildName ? `「${guildName}」` : "サーバー"}へようこそ！`,
        "平日(月〜金)は毎日、私がその日に一緒に遊ぶメンバーを選びます！",
        `また、あなた専用の自己紹介チャンネル <#${bioChannelId}> を作ったので、ぜひ自己紹介を投稿してください！`,
        "投稿した自己紹介は、一緒に遊ぶときに自動で共有されます。何度でも投稿し直せて、使われるのは最新の1件だけです。",
      ].join("\n"),
    );
    await log(`案内をウェルカム用チャンネルに送信しました(user=${userId})`);

    // 段位は選択肢から選ぶだけ。選択後は /段位 と同じ処理でロールが付与される
    step = "段位選択メニューの送信";
    await notify(
      bot,
      welcomeChannelId,
      tierSelectMessage(
        "## 段位の設定\nあなたの段位を下から選んでください。あとから変えたいときは、/段位 でいつでも変更できます。",
      ),
    );
    await log(`段位選択メニューをウェルカム用チャンネルに送信しました(user=${userId})`);

    step = "チャンネルが消えることの案内の送信";
    await notify(
      bot,
      welcomeChannelId,
      "## このチャンネルについて\n段位の選択と自己紹介の投稿が両方済むと、このチャンネルは自動で消えます。",
    );
    await log(`チャンネルが消えることの案内を送信しました(user=${userId})`);

    step = "匿名掲示板の案内の送信";
    await notify(
      bot,
      welcomeChannelId,
      `## 匿名掲示板\n<#${boardChannelId}> では、名前を出さずに発言できます。このbotにDMで送ったメッセージが、匿名で掲示板に載ります。画像も送れますよ。\nDMで送ったメッセージを編集すると、掲示板の投稿も書き換わります(文字のみ)。投稿を消したいときは、DMのメッセージを削除するか、掲示板で直接削除してください。`,
    );
    await log(`匿名掲示板の案内を送信しました(user=${userId})`);
  } catch (error) {
    await log(
      `入室案内の送信に失敗しました(user=${userId}, 失敗した段階=${step}): ${
        explainDiscordError(error)
      }\n詳細: ${describeError(error)}`,
    );
    if (createdChannel) {
      // 空のまま残さない。次回の保守処理で作り直して、案内を送り直す
      await deleteWelcomeChannel(bot, db, userId, "案内の送信に失敗したため").catch(() => {});
    }
  }
}

/**
 * 保守処理用。すでにいるメンバーも含めて、案内が完了していない人(段位が未設定、または自己紹介が未投稿)に、
 * ウェルカム用チャンネルが無ければ作って案内を送る。
 */
async function ensureWelcomeForIncompleteMembers(): Promise<void> {
  const members = (await fetchAllMembers(bot)).filter((m) => m.user && !m.user.bot);
  let provided = 0;
  for (const member of members) {
    const userId = member.user!.id.toString();
    if (await isOnboardingComplete(userId)) continue;
    if (await getWelcomeChannel(db, userId)) continue;
    const bioChannel = await getBioChannel(db, userId);
    if (!bioChannel) continue; // 自己紹介チャンネルの修復(runBioReconcile)が先に作る
    await provideWelcome(userId, displayName(member), BigInt(bioChannel.channelId));
    provided++;
  }
  await log(
    `案内が未完了の人のウェルカム用チャンネルを確認しました(対象: ${provided}人に新規送信)`,
  );
}

/** 案内が完了した人のウェルカム用チャンネルを、返信を読む時間を置いてから削除する */
async function closeWelcomeChannelLater(userId: string): Promise<void> {
  if (!await getWelcomeChannel(db, userId)) return;
  if (!await isOnboardingComplete(userId)) return;
  setTimeout(async () => {
    try {
      if (!await isOnboardingComplete(userId)) return;
      await deleteWelcomeChannel(bot, db, userId, "段位の設定と自己紹介の投稿が完了したため");
      await log(`ウェルカム用チャンネルを削除しました(user=${userId}, 理由=案内が完了)`);
    } catch (error) {
      await log(
        `ウェルカム用チャンネルの削除に失敗しました(user=${userId}): ${describeError(error)}`,
      );
    }
  }, 15_000);
}

/**
 * 起動時と毎日3:00(JST)に同じ内容を実行する保守処理。
 * 起動しなかった期間があっても、毎日のバッチで必ず状態が整う。
 * - 管理対象の権限設定の再適用
 * - 匿名掲示板の説明文(管理者が投稿者を確認できる旨)の再適用
 * - 招待を誰でもできる状態にそろえる(@everyoneの権限と、招待の一時停止の解除)
 * - サーバーのシステムメッセージ設定(ウェルカム・ブースト・ヒントの表示、送信先チャンネル)の再適用
 * - pickup用のテキストチャンネル/VCが揃っているかの確認(無ければ作成)と、その権限の再適用
 * - 自己紹介チャンネルの差分修復と、チャンネル名・権限の同期
 * - ウェルカム用チャンネルの片付け(案内が完了した人・サーバーを抜けた人の分)
 * - 案内が未完了の人(すでにいるメンバー含む)へのウェルカム用チャンネルの用意
 */
async function runMaintenance(): Promise<void> {
  await applyManagedPermissions(bot, log);
  await applyGuildSettings(bot, log);
  await applyInviteSettings(bot, log);
  try {
    if (await ensureBoardTopic(bot)) await log("OK: 匿名掲示板の説明文を更新しました");
  } catch (error) {
    await log(`NG: 匿名掲示板の説明文の更新に失敗しました: ${describeError(error)}`);
  }
  try {
    const created = await ensurePickupChannels(bot, db);
    await log(
      created
        ? "pickup用のテキストチャンネルとVCが揃っていなかったため作成しました"
        : "pickup用のテキストチャンネルとVCは揃っています",
    );
  } catch (error) {
    await log(`pickup用チャンネルの確認に失敗しました: ${describeError(error)}`);
  }
  await applyPickupChildPermissions(bot, await getPickupChannelIds(db), log);
  await runBioReconcile();
  await cleanupWelcomeChannels(bot, db, isOnboardingComplete, log);
  try {
    await ensureWelcomeForIncompleteMembers();
  } catch (error) {
    await log(`ウェルカム用チャンネルの確認に失敗しました: ${describeError(error)}`);
  }
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
    await log(`自己紹介チャンネルの差分チェックに失敗しました: ${describeError(error)}`);
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

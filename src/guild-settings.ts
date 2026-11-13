import { SystemChannelFlags } from "@discordeno/bot";
import { describeError } from "./errors.ts";

interface GuildSettingsEditor {
  rest: {
    get: (url: string) => Promise<unknown>;
    patch: (url: string, options: { body: unknown }, ...rest: unknown[]) => Promise<unknown>;
  };
  helpers: {
    getGuild: (
      guildId: bigint,
    ) => Promise<{ systemChannelId?: bigint | null; systemChannelFlags?: number }>;
    editGuild: (
      guildId: bigint,
      options: { systemChannelId?: bigint | null; systemChannelFlags?: number },
      reason?: string,
    ) => Promise<unknown>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
// システムメッセージの送信先は「運用通知」(運用ログ用チャンネル)
const systemChannelId = BigInt(Deno.env.get("LOG_CHANNEL_ID")!);

/**
 * システムメッセージ関連のフラグ。Discordの仕様上、各ビットは「表示しない」を意味する。
 * 立てる(=表示しない)のは、「ウェルカムメッセージにスタンプで反応するよう促す」だけ。
 * それ以外の3つ(ウェルカムメッセージの送信・ブースト通知・サーバーに役立つヒント)は、
 * 下ろして(=表示する)おく。
 */
const SUPPRESS_BITS = SystemChannelFlags.SuppressJoinNotifications |
  SystemChannelFlags.SuppressPremiumSubscriptions |
  SystemChannelFlags.SuppressGuildReminderNotifications |
  SystemChannelFlags.SuppressJoinNotificationReplies;
const DESIRED_SUPPRESSED = SystemChannelFlags.SuppressJoinNotificationReplies;

/**
 * サーバーのシステムメッセージの設定を宣言どおりにそろえる(起動時と毎日の保守処理で実行)。
 * - ウェルカムメッセージの送信: ON
 * - ウェルカムメッセージにスタンプで反応するよう促す: OFF
 * - ブースト時のメッセージ送信: ON
 * - サーバーに役立つヒント: ON
 * - システムメッセージのチャンネル: 運用通知
 * 既にそろっている場合は何も書き込まない。上の4項目以外のフラグ(ロール購読の通知など)は変更しない。
 */
export async function applyGuildSettings(
  bot: GuildSettingsEditor,
  log: (message: string) => Promise<void>,
): Promise<void> {
  try {
    const guild = await bot.helpers.getGuild(guildId);
    const currentFlags = guild.systemChannelFlags ?? 0;
    const desiredFlags = (currentFlags & ~SUPPRESS_BITS) | DESIRED_SUPPRESSED;

    if (guild.systemChannelId === systemChannelId && currentFlags === desiredFlags) {
      await log("OK: サーバーのシステムメッセージ設定は、すでに宣言どおりです");
      return;
    }

    await bot.helpers.editGuild(
      guildId,
      { systemChannelId, systemChannelFlags: desiredFlags },
      "システムメッセージの設定を自動で整える",
    );
    await log(
      `OK: サーバーのシステムメッセージ設定を更新しました(チャンネル: ${
        guild.systemChannelId ?? "なし"
      } → ${systemChannelId}, フラグ: ${currentFlags} → ${desiredFlags})`,
    );
  } catch (error) {
    await log(`NG: サーバーのシステムメッセージ設定の適用に失敗しました: ${describeError(error)}`);
  }
}

const CREATE_INSTANT_INVITE = 1n << 0n;

/**
 * 招待を「誰でもできる」状態にそろえる(起動時と毎日の保守処理で実行)。
 * - @everyone ロールに「招待を作成」の権限を付ける(他の権限は変更しない)
 * - サーバーの「招待の一時停止」(INVITES_DISABLED)が有効なら、解除する
 * 既にそろっている場合は何も書き込まない。
 */
export async function applyInviteSettings(
  bot: GuildSettingsEditor,
  log: (message: string) => Promise<void>,
): Promise<void> {
  try {
    const roles = await bot.rest.get(`/guilds/${guildId}/roles`) as {
      id: string;
      permissions: string;
    }[];
    // @everyone ロールのidはギルドidと常に同一
    const everyone = roles.find((role) => role.id === guildId.toString());
    if (!everyone) throw new Error("@everyoneロールが見つかりませんでした");

    const currentPermissions = BigInt(everyone.permissions);
    if ((currentPermissions & CREATE_INSTANT_INVITE) === 0n) {
      await bot.rest.patch(`/guilds/${guildId}/roles/${guildId}`, {
        body: { permissions: (currentPermissions | CREATE_INSTANT_INVITE).toString() },
      });
      await log("OK: @everyoneに「招待を作成」の権限を付けました");
    } else {
      await log("OK: @everyoneは、すでに招待を作成できます");
    }

    const guild = await bot.rest.get(`/guilds/${guildId}`) as { features?: string[] };
    const features = guild.features ?? [];
    if (features.includes("INVITES_DISABLED")) {
      await bot.rest.patch(`/guilds/${guildId}`, {
        body: { features: features.filter((feature) => feature !== "INVITES_DISABLED") },
      });
      await log("OK: サーバーの「招待の一時停止」を解除しました");
    }
  } catch (error) {
    await log(`NG: 招待の設定の適用に失敗しました: ${describeError(error)}`);
  }
}

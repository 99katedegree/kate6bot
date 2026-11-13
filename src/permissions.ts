import { OverwriteTypes, type PermissionStrings } from "@discordeno/bot";
import { describeError } from "./errors.ts";

interface ChannelPermissionEditor {
  helpers: {
    editChannelPermissionOverrides: (
      channelId: bigint,
      options: {
        id: bigint;
        type: OverwriteTypes;
        allow?: PermissionStrings[];
        deny?: PermissionStrings[];
      },
      reason?: string,
    ) => Promise<void>;
  };
}

// このアプリが管理する、固定のロール/チャンネルのid一覧(いわばTerraformのproviderの一箇所管理)
const ROLE_IDS = {
  // @everyone ロールのidはギルドidと常に同一
  everyone: BigInt(Deno.env.get("GUILD_ID")!),
  pickup: BigInt(Deno.env.get("PICKUP_ROLE_ID")!),
} as const;

const CHANNEL_IDS = {
  log: BigInt(Deno.env.get("LOG_CHANNEL_ID")!),
  announce: BigInt(Deno.env.get("ANNOUNCE_CHANNEL_ID")!),
  pickupCategory: BigInt(Deno.env.get("PICKUP_CATEGORY_ID")!),
  profileCategory: BigInt(Deno.env.get("PROFILE_CATEGORY_ID")!),
  anonymousBoard: BigInt(Deno.env.get("ANONYMOUS_CHANNEL_ID")!),
} as const;

interface ManagedPermission {
  description: string;
  channel: keyof typeof CHANNEL_IDS;
  role: keyof typeof ROLE_IDS;
  allow?: PermissionStrings[];
  deny?: PermissionStrings[];
}

/**
 * このアプリが起動時と毎日の保守処理で強制する、固定チャンネル/カテゴリーの権限の宣言的な一覧。
 * ここが唯一のソース・オブ・トゥルースで、ズレていても保守処理の度に全て上書きされる。
 * (ユーザーごとの自己紹介チャンネルの権限は動的に決まるため、ここには含まれない。profile/bio.ts参照)
 */
export const MANAGED_PERMISSIONS: ManagedPermission[] = [
  {
    description: "運用ログを@everyoneから非表示に",
    channel: "log",
    role: "everyone",
    deny: ["VIEW_CHANNEL"],
  },
  {
    description: "アナウンスチャンネルの閲覧・コマンド利用を保証",
    channel: "announce",
    role: "everyone",
    allow: ["VIEW_CHANNEL", "USE_SLASH_COMMANDS"],
  },
  {
    description: "pickupカテゴリーを@everyoneから不可視に",
    channel: "pickupCategory",
    role: "everyone",
    deny: ["VIEW_CHANNEL"],
  },
  {
    description: "pickupロールにテキストチャンネルとVCの利用を許可",
    channel: "pickupCategory",
    role: "pickup",
    allow: ["VIEW_CHANNEL", "CONNECT", "SPEAK", "SEND_MESSAGES"],
  },
  {
    description: "匿名掲示板を、@everyoneは閲覧とリアクションのみに(投稿はbot経由)",
    channel: "anonymousBoard",
    role: "everyone",
    allow: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "ADD_REACTIONS"],
    deny: [
      "SEND_MESSAGES",
      "CREATE_PUBLIC_THREADS",
      "CREATE_PRIVATE_THREADS",
      "SEND_MESSAGES_IN_THREADS",
    ],
  },
  {
    description: "profileカテゴリーを@everyoneから不可視に",
    channel: "profileCategory",
    role: "everyone",
    deny: ["VIEW_CHANNEL"],
  },
];

/**
 * 保守処理(起動時と毎日)で実行し、MANAGED_PERMISSIONS を1件ずつ適用する。
 * 1件失敗しても他の適用は止めず、成否をそれぞれログに残す。
 */
export async function applyManagedPermissions(
  bot: ChannelPermissionEditor,
  log: (message: string) => Promise<void>,
): Promise<void> {
  for (const entry of MANAGED_PERMISSIONS) {
    try {
      await bot.helpers.editChannelPermissionOverrides(
        CHANNEL_IDS[entry.channel],
        {
          id: ROLE_IDS[entry.role],
          type: OverwriteTypes.Role,
          allow: entry.allow,
          deny: entry.deny,
        },
        `起動時の自動セットアップ: ${entry.description}`,
      );
      await log(`OK: ${entry.description}`);
    } catch (error) {
      await log(`NG: ${entry.description}: ${describeError(error)}`);
    }
  }
}

/**
 * pickupカテゴリーに設定した権限を、中のチャンネル(テキスト/VC)にも直接適用する。
 * Discordはカテゴリーの権限を変えても既存の子チャンネルには反映しないため、ここで揃える。
 */
export async function applyPickupChildPermissions(
  bot: ChannelPermissionEditor,
  channelIds: bigint[],
  log: (message: string) => Promise<void>,
): Promise<void> {
  const entries = MANAGED_PERMISSIONS.filter((entry) => entry.channel === "pickupCategory");
  for (const channelId of channelIds) {
    for (const entry of entries) {
      try {
        await bot.helpers.editChannelPermissionOverrides(
          channelId,
          {
            id: ROLE_IDS[entry.role],
            type: OverwriteTypes.Role,
            allow: entry.allow,
            deny: entry.deny,
          },
          `pickupチャンネルの権限を再適用: ${entry.description}`,
        );
      } catch (error) {
        await log(
          `NG: pickupチャンネル(${channelId})の権限: ${entry.description}: ${describeError(error)}`,
        );
      }
    }
  }
}

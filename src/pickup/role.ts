import type { Database } from "../db.ts";

interface RoleEditor {
  helpers: {
    addRole: (guildId: bigint, userId: bigint, roleId: bigint, reason?: string) => Promise<void>;
    removeRole: (
      guildId: bigint,
      userId: bigint,
      roleId: bigint,
      reason?: string,
    ) => Promise<void>;
  };
}

interface VoiceMover {
  helpers: {
    editMember: (
      guildId: bigint,
      userId: bigint,
      options: { channelId: null },
      reason?: string,
    ) => Promise<unknown>;
  };
}

const guildId = BigInt(Deno.env.get("GUILD_ID")!);
const pickupRoleId = BigInt(Deno.env.get("PICKUP_ROLE_ID")!);

export async function getCurrentPickupHolders(db: Database): Promise<string[]> {
  const result = await db.execute("SELECT discord_user_id FROM current_pickup");
  return result.rows.map((row) => String(row.discord_user_id));
}

async function setCurrentPickupHolders(db: Database, userIds: string[]): Promise<void> {
  await db.batch(
    [
      "DELETE FROM current_pickup",
      ...userIds.map((userId) => ({
        sql: "INSERT INTO current_pickup (discord_user_id) VALUES (?)",
        args: [userId],
      })),
    ],
    "write",
  );
}

/** 前回pickupロールを持っていた人全員から剥奪する。剥奪した人のidを返す。 */
export async function revokePickupRole(bot: RoleEditor, db: Database): Promise<string[]> {
  const holders = await getCurrentPickupHolders(db);
  for (const userId of holders) {
    await bot.helpers.removeRole(guildId, BigInt(userId), pickupRoleId, "pickup入れ替え");
  }
  return holders;
}

/**
 * 指定した人たちを強制的にボイスチャンネルから切断する。
 * ボイスに接続していない人に対してはエラーになるが、無視して問題ない。
 */
export async function forceDisconnectFromVoice(
  bot: VoiceMover,
  userIds: string[],
): Promise<{ succeeded: string[]; skipped: string[] }> {
  const succeeded: string[] = [];
  const skipped: string[] = [];
  for (const userId of userIds) {
    try {
      await bot.helpers.editMember(
        guildId,
        BigInt(userId),
        { channelId: null },
        "pickupクリーンアップ: 強制退出",
      );
      succeeded.push(userId);
    } catch {
      skipped.push(userId);
    }
  }
  return { succeeded, skipped };
}

/** 今回選ばれた人全員にpickupロールを付与し、DBの保持者一覧を更新する。 */
export async function grantPickupRole(
  bot: RoleEditor,
  db: Database,
  userIds: string[],
): Promise<void> {
  for (const userId of userIds) {
    await bot.helpers.addRole(guildId, BigInt(userId), pickupRoleId, "pickup付与");
  }
  await setCurrentPickupHolders(db, userIds);
}

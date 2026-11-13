/**
 * エラーをログ用の文字列にする。
 * Discordeno のRESTエラーは、メッセージが常に「Failed to send request to discord.」になり、
 * 本当の理由(HTTPステータスとDiscordのエラーコード)は cause に入っているため、それも含める。
 */
export function describeError(error: unknown): string {
  const base = String(error);
  const cause = (error as { cause?: { status?: number; body?: unknown } } | null)?.cause;
  if (cause && typeof cause === "object" && ("status" in cause || "body" in cause)) {
    const body = typeof cause.body === "string" ? cause.body : JSON.stringify(cause.body);
    return `${base} [status=${cause.status ?? "?"} body=${body ?? ""}]`;
  }
  return base;
}

/** Discordのエラーコードのうち、DM送信などで起こりやすいものの日本語の説明 */
const DISCORD_ERROR_HINTS: Record<number, string> = {
  50007:
    "相手にDMを送れません(「サーバーメンバーからのDMを許可」がオフ、またはbotをブロックしている可能性が高い)",
  50278:
    "共通のサーバーが無いと判定されてDMを送れません(相手が「サーバーメンバーからのDMを許可」をオフにしている場合などに出る。実際にはサーバーに参加済みのことがある)",
  40003: "DMを短時間に送りすぎて、制限されています",
  10013: "ユーザーが存在しません",
  50001: "botにアクセス権限がありません",
  50013: "botに必要な権限が足りません",
  20026: "botがDMを送る機能を制限されています",
};

/** 失敗の原因を、HTTPステータス・Discordのエラーコード・日本語の説明に分けてログ用の文字列にする */
export function explainDiscordError(error: unknown): string {
  const cause = (error as { cause?: { status?: number; body?: unknown } } | null)?.cause;
  let status: number | undefined;
  let code: number | undefined;
  let message: string | undefined;
  if (cause && typeof cause === "object") {
    status = cause.status;
    try {
      const parsed = typeof cause.body === "string" ? JSON.parse(cause.body) : cause.body;
      code = (parsed as { code?: number })?.code;
      message = (parsed as { message?: string })?.message;
    } catch {
      // 本文がJSONでない場合は無視
    }
  }
  const parts = [
    status !== undefined ? `HTTP ${status}` : "HTTPステータス不明",
    code !== undefined ? `Discordエラーコード ${code}` : null,
    message ? `Discordの説明「${message}」` : null,
    code !== undefined && DISCORD_ERROR_HINTS[code]
      ? `想定される原因: ${DISCORD_ERROR_HINTS[code]}`
      : null,
  ].filter(Boolean);
  return parts.join(" / ");
}

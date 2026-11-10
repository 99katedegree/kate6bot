import type { InteractionCallbackData } from "@discordeno/bot";

interface Respondable {
  respond: (
    response: string | InteractionCallbackData,
    options?: { isPrivate?: boolean },
  ) => Promise<unknown>;
}

/**
 * インタラクションへの応答を常にエフェメラル(本人にしか見えない)で送る。
 * 呼び出し側が isPrivate を指定し忘れる余地を無くすための唯一の応答経路。
 */
export async function respondPrivately(
  interaction: Respondable,
  response: string | InteractionCallbackData,
): Promise<void> {
  await interaction.respond(response, { isPrivate: true });
}

import {
  createBot,
  type InteractionCallbackData,
  InteractionResponseTypes,
  InteractionTypes,
  MessageComponentTypes,
  TextStyles,
} from "@discordeno/bot";
import { getBio, MAX_BIO_LENGTH, setBio } from "./bio/bio.ts";
import {
  BIO_INPUT_CUSTOM_ID,
  BIO_MODAL_CUSTOM_ID,
  COMMAND_BIO,
  COMMAND_TIER,
  TIER_SELECT_CUSTOM_ID,
} from "./commands.ts";
import { openDatabase } from "./db.ts";
import { respondPrivately } from "./discord/respond.ts";
import { setTier } from "./tier/members.ts";
import { isTier, tierLabel, TIERS } from "./tier/tiers.ts";

const db = await openDatabase();

/** 段位を選ぶセレクトメニュー付きのメッセージ */
function tierSelectMessage(): InteractionCallbackData {
  return {
    content:
      "あなたの段位を下から選んでください。あとから変えたいときは、もう一度 /段位 を実行してください。",
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
  desiredProperties: {
    user: { id: true, username: true, toggles: true },
    interaction: { id: true, token: true, type: true, data: true, user: true },
  },
  events: {
    ready: ({ shardId, user }) => {
      console.log(`Shard ${shardId} ready as ${user.username}`);
    },
    interactionCreate: async (interaction) => {
      const userId = interaction.user?.id.toString();
      if (!userId) return;

      // /段位: セレクトメニューを出す
      if (
        interaction.type === InteractionTypes.ApplicationCommand &&
        interaction.data?.name === COMMAND_TIER
      ) {
        await respondPrivately(interaction, tierSelectMessage());
        return;
      }

      // /自己紹介: 入力フォームを出す(登録済みなら、いまの内容を入れた状態で開く)
      if (
        interaction.type === InteractionTypes.ApplicationCommand &&
        interaction.data?.name === COMMAND_BIO
      ) {
        const current = await getBio(db, userId);
        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
          type: InteractionResponseTypes.Modal,
          data: {
            customId: BIO_MODAL_CUSTOM_ID,
            title: "自己紹介",
            components: [
              {
                type: MessageComponentTypes.ActionRow,
                components: [
                  {
                    type: MessageComponentTypes.InputText,
                    customId: BIO_INPUT_CUSTOM_ID,
                    label: "自己紹介",
                    style: TextStyles.Paragraph,
                    placeholder: "よく遊ぶ時間帯や、好きなゲームなど",
                    value: current ?? undefined,
                    required: true,
                    minLength: 1,
                    maxLength: MAX_BIO_LENGTH,
                  },
                ],
              },
            ],
          },
        });
        return;
      }

      // 段位のセレクトメニューで選ばれた
      if (
        interaction.type === InteractionTypes.MessageComponent &&
        interaction.data?.customId === TIER_SELECT_CUSTOM_ID
      ) {
        const selected = interaction.data.values?.[0];
        if (!selected || !isTier(selected)) {
          console.log(`段位選択メニューの値が不正でした(user=${userId}): ${selected}`);
          return;
        }
        await setTier(db, userId, selected);
        console.log(`段位を設定しました(user=${userId}, tier=${selected})`);
        await respondPrivately(interaction, `段位を「${tierLabel(selected)}」に設定しました！`);
        return;
      }

      // 自己紹介のフォームが送信された
      if (
        interaction.type === InteractionTypes.ModalSubmit &&
        interaction.data?.customId === BIO_MODAL_CUSTOM_ID
      ) {
        const input = interaction.data.components
          ?.flatMap((row) => row.components ?? [])
          .find((component) => component.customId === BIO_INPUT_CUSTOM_ID);
        const content = (input?.value ?? "").trim();
        if (content.length === 0) {
          await respondPrivately(interaction, "自己紹介が空だったので、保存しませんでした。");
          return;
        }
        await setBio(db, userId, content);
        console.log(`自己紹介を保存しました(user=${userId}, length=${content.length})`);
        // 返信は2000文字までなので、長い場合は先頭だけ表示する
        const preview = content.length > 1500 ? `${content.slice(0, 1500)}…` : content;
        await respondPrivately(interaction, `自己紹介を保存しました！\n\n${preview}`);
        return;
      }
    },
  },
});

await bot.start();

# kate6bot

Discordサーバーで、平日(月〜金)の毎日「一緒に遊ぶ人」を自動で選び、集合用のVCを用意するbotです。

📖 **botができること(非エンジニア向けスライド)**: https://99katedegree.github.io/kate6bot/

スライドの元ファイルは [`docs/slides.md`](./docs/slides.md) です(Marp形式)。`main` にpushすると
GitHub Pages へ自動デプロイされます。

## 開発者向け

- 実行環境: [Deno](https://deno.com/) / ライブラリ: discordeno / DB:
  [Turso](https://turso.tech/)(libSQL。`TURSO_URL` / `TURSO_TOKEN` で接続)
- ホスティング: Fly.io(`fly.toml`、GitHub Actionsでデプロイ)
- 定期処理は `Deno.cron` で実行(`src/main.ts`)
- DBスキーマ: [`schema.dbml`](./schema.dbml)

```sh
cp .env.example .env          # 値を埋める
deno task register-commands   # /段位 コマンドを登録
deno task dev                 # 開発起動
```

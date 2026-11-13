# kate6bot

「段位」と「自己紹介」を、botとのDMだけで登録するDiscord botです。

📖 **botができること(非エンジニア向けスライド)**: https://99katedegree.github.io/kate6bot/

スライドの元ファイルは [`docs/slides.md`](./docs/slides.md) です(Marp形式)。`main` にpushすると
GitHub Pages へ自動デプロイされます。

## 機能

- `/段位`: 段位をセレクトメニューから選んで保存する
- `/自己紹介`:
  入力フォーム(複数行)で自己紹介を保存・上書きする(登録済みなら、いまの内容を入れた状態で開く)

どちらもグローバルコマンドで、ボットとのDMで使います(サーバーのチャンネルでは使いません)。サーバーが無くても、ユーザーインストールで使えます。
**開発者ポータルの「Installation」で「User Install」を有効にしておいてください。**

## 開発者向け

- 実行環境: [Deno](https://deno.com/) / ライブラリ: discordeno / DB:
  [Turso](https://turso.tech/)(libSQL。`TURSO_URL` / `TURSO_TOKEN` で接続)
- ホスティング: Fly.io(`fly.toml`、GitHub Actionsでデプロイ)
- DBスキーマ: [`schema.dbml`](./schema.dbml)

```sh
cp .env.example .env          # 値を埋める
deno task register-commands   # /段位 と /自己紹介 をグローバルコマンドとして登録
deno task dev                 # 開発起動
```

## 経緯

以前は、サーバー向けの機能(毎日のメンバー選出・自己紹介チャンネル・匿名掲示板など)を持っていました。
DM専用の運用に切り替えるため、`段位` と `自己紹介` 以外のロジックは削除しています。
過去の実装は、gitの履歴から参照できます(`1ea93a7` 以前)。

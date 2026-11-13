-- 入室した人ごとに作る「ウェルカム用チャンネル」(カテゴリーに入れず、チャンネル直下に作る)。
-- 段位の設定が済んだら削除する。
CREATE TABLE welcome_channels (
  discord_user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);

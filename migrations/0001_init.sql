CREATE TABLE members (
  discord_user_id TEXT PRIMARY KEY,
  tier TEXT,
  updated_at TEXT,
  pick_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE weekly_skip (
  discord_user_id TEXT NOT NULL,
  week_of TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, week_of)
);

CREATE TABLE pair_history (
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_a, user_b)
);

CREATE TABLE current_pickup (
  discord_user_id TEXT PRIMARY KEY
);

-- pickupカテゴリーは「テキストチャンネル1つ + ボイスチャンネル1つ」の構成。
-- botの投稿はテキストチャンネルにのみ行い、VCの内蔵チャットには一切投稿しない。
CREATE TABLE pickup_channel (
  voice_channel_id TEXT NOT NULL,
  text_channel_id TEXT
);

CREATE TABLE bio_channels (
  discord_user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  last_message_id TEXT
);

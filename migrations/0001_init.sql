-- 段位(1人1件。/段位 で設定・変更する)
CREATE TABLE members (
  discord_user_id TEXT PRIMARY KEY,
  tier TEXT,
  updated_at TEXT NOT NULL
);

-- 自己紹介(1人1件。/自己紹介 のフォームで保存・上書きする)
CREATE TABLE bios (
  discord_user_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

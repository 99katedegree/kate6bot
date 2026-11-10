-- pickupカテゴリーは「テキストチャンネル1つ + ボイスチャンネル1つ」の構成にする。
-- botの投稿はテキストチャンネルにのみ行い、VCの内蔵チャットには一切投稿しない。
ALTER TABLE pickup_channel RENAME COLUMN channel_id TO voice_channel_id;
ALTER TABLE pickup_channel ADD COLUMN text_channel_id TEXT;

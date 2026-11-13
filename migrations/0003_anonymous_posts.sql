-- 匿名掲示板への投稿の対応表。DMのメッセージを編集・削除したときに、掲示板の投稿へ反映するために使う。
-- content は、最後に反映した本文(リンクのプレビューなど、本文が変わらない更新を見分けるため)。
CREATE TABLE anonymous_posts (
  dm_message_id TEXT PRIMARY KEY,
  board_message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL
);

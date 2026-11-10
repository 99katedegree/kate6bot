const jstDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" });

/** 指定した日時のJSTでの日付(YYYY-MM-DD)を返す */
export function jstDateString(date: Date): string {
  return jstDateFormatter.format(date);
}

/** 木曜のリマインド送信時に使う、4日後(次の月曜)のJST日付 */
export function upcomingMonday(now: Date): string {
  const fourDaysLater = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
  return jstDateString(fourDaysLater);
}

/** 指定した日時が属する週の月曜日のJST日付(YYYY-MM-DD)を返す。週単位の「参加しない」の照合キー */
export function weekStartMonday(date: Date): string {
  const [y, m, d] = jstDateString(date).split("-").map(Number);
  const jstDay = new Date(Date.UTC(y, m - 1, d));
  const daysSinceMonday = (jstDay.getUTCDay() + 6) % 7;
  jstDay.setUTCDate(jstDay.getUTCDate() - daysSinceMonday);
  return jstDay.toISOString().slice(0, 10);
}

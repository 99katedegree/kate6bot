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

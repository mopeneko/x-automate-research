/**
 * JST time helpers. All window logic operates in JST (Asia/Tokyo, UTC+9)
 * regardless of the host timezone, so cron times and window boundaries
 * stay correct even if the VPS clock drifts. See ADR-0003.
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Returns a Date whose UTC fields represent JST wall-clock time. */
function toJst(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

/** JST date key (YYYY-MM-DD) for a given instant. Used as the Tweet Store filename. */
export function jstDateKey(date: Date): string {
  return toJst(date).toISOString().slice(0, 10);
}

/** JST minutes-of-day [0,1440) for a given instant. Used for window slicing. */
export function jstMinutesOfDay(date: Date): number {
  const jst = toJst(date);
  return jst.getUTCHours() * 60 + jst.getUTCMinutes();
}

/** True if the instant falls in [startMin, endMin) on its JST day. */
export function inWindow(date: Date, startMin: number, endMin: number): boolean {
  const m = jstMinutesOfDay(date);
  return m >= startMin && m < endMin;
}

/**
 * The JST date a send job should process.
 * - 朝場/昼場: processed on the same JST day (cron at 12:30 / 16:30 JST).
 * - 夜場/Daily: processed at JST 00:00, which is the *previous* JST day's 24:00,
 *   so the target date is the day before the cron fire time.
 */
export function targetDateForSend(windowName: string, fireAt: Date = new Date()): string {
  if (windowName === "夜場" || windowName === "Daily") {
    // JST 00:00 cron → process the JST day that just ended.
    const jst = new Date(toJst(fireAt).getTime() - 24 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  }
  return jstDateKey(fireAt);
}

// Rolling 30-day billing periods anchored to the subscription start date.
// Panera's cap is per rolling period, not per calendar month.

export const DAY = 86_400_000;
export const CYCLE_DAYS = 30;
export const CAP = 30;
export const COOLDOWN_MS = 2 * 60 * 60 * 1000;

/**
 * Resolve the rolling period containing `now`.
 *
 * `daysLeft` is `CYCLE_DAYS - day` rather than a re-derived ceiling of the
 * remaining milliseconds. The two disagree by one for any `now` past midnight,
 * and `day + daysLeft === 30` is the invariant the widget copy depends on.
 */
export function cycleFor(anchorISO, now = Date.now()) {
  const anchor = new Date(anchorISO + 'T00:00:00Z').getTime();
  if (Number.isNaN(anchor)) throw new Error(`bad anchor date: ${anchorISO}`);
  // Date() silently normalizes overflow — '2026-02-30' becomes 2026-03-02,
  // which would shift every period boundary by two days with no error. Compare
  // the round-trip to catch a typo in the anchor rather than acting on it.
  if (new Date(anchor).toISOString().slice(0, 10) !== anchorISO) {
    throw new Error(`bad anchor date: ${anchorISO}`);
  }

  const idx = Math.max(0, Math.floor((now - anchor) / DAY / CYCLE_DAYS));
  const start = anchor + idx * CYCLE_DAYS * DAY;
  const endExclusive = start + CYCLE_DAYS * DAY;

  // Before the anchor the subscription does not exist yet; clamp day to 1 so
  // callers never see a zero or negative day number.
  const day = Math.max(1, Math.floor((now - start) / DAY) + 1);

  return {
    start: new Date(start),
    end: new Date(endExclusive - 1),
    endExclusive: new Date(endExclusive),
    day,
    daysLeft: CYCLE_DAYS - day,
  };
}

/** YYYY-MM-DD in UTC. */
export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Projected end-of-period total at the current rate.
 * Day 1 with one redemption projects 30, not 900 — the divisor is elapsed days.
 */
export function paceFor(used, day) {
  if (day <= 0) return 0;
  return Math.round((used / day) * CYCLE_DAYS);
}

/**
 * Alert level. Ordered most-severe first; `pace` only fires when the
 * projection would overshoot the cap by more than a rounding wobble.
 */
export function levelFor(used, day) {
  if (used >= CAP) return 'hit';
  if (used >= 27) return 'warn';
  if (paceFor(used, day) > 31) return 'pace';
  return 'ok';
}

import { CAP, COOLDOWN_MS, cycleFor, isoDate, levelFor, paceFor } from './cycle.js';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Build the payload every client renders. The poller uses the same function so
 * that alert thresholds and the widget can never disagree about the level.
 */
export function buildStatus(store, anchorDate, now = Date.now()) {
  const cycle = cycleFor(anchorDate, now);
  const startISO = cycle.start.toISOString();
  const endISO = cycle.endExclusive.toISOString();

  const used = store.countBetween(startISO, endISO);
  // Counted, but flagged: savings applied with nothing fully comped. Surfaced
  // so the operator can reconcile without reading journald.
  const needsReview = store.countReviewBetween(startISO, endISO);
  const last = store.latest();
  const lastMs = last ? new Date(last.occurredAt ?? last.occurred_at).getTime() : null;

  // Cooldown runs from the most recent redemption regardless of source, so a
  // manually logged drink starts the clock the same as a parsed one.
  const readyMs = lastMs === null ? null : lastMs + COOLDOWN_MS;
  const cooling = readyMs !== null && now < readyMs;

  const lastPollAt = store.getMeta('last_poll_at');
  const staleMinutes = lastPollAt
    ? Math.max(0, Math.floor((now - new Date(lastPollAt).getTime()) / 60_000))
    : null;

  return {
    used,
    needsReview,
    cap: CAP,
    remaining: Math.max(0, CAP - used),
    cycleStart: isoDate(cycle.start),
    cycleEnd: isoDate(cycle.end),
    day: cycle.day,
    daysLeft: cycle.daysLeft,
    pace: paceFor(used, cycle.day),
    lastAt: lastMs === null ? null : iso(lastMs),
    readyAt: readyMs === null ? null : iso(readyMs),
    cooling,
    level: levelFor(used, cycle.day),
    lastPollAt: lastPollAt ?? null,
    staleMinutes,
  };
}

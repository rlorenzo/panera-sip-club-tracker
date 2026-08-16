import { config } from './config.js';

const RANK = { ok: 0, pace: 1, warn: 2, hit: 3 };

async function publish(topicConfig, { title, message, priority = 'default', tags = [] }) {
  if (!topicConfig.enabled) return { skipped: 'no topic configured' };

  const headers = {
    Title: title,
    Priority: priority,
    Tags: tags.join(','),
  };
  if (topicConfig.token) headers.Authorization = `Bearer ${topicConfig.token}`;

  const res = await fetch(`${topicConfig.server}/${topicConfig.topic}`, {
    method: 'POST',
    headers,
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
  return { sent: true };
}

/**
 * Publish threshold and cooldown notifications, but only on transitions.
 *
 * A push every ten minutes repeating the same number gets muted within a day,
 * and a muted channel is a dead channel — so every send here is gated on a
 * stored marker that changes only when the underlying state does.
 */
export async function maybeAlert(store, status, opts = {}) {
  const ntfy = opts.ntfy ?? config.ntfy;
  const send = opts.publish ?? publish;
  const now = opts.now ?? Date.now();
  const sent = [];

  // A new period resets the ratchet; last period's "hit" must not suppress
  // this period's "warn".
  if (store.getMeta('last_alert_cycle') !== status.cycleStart) {
    store.setMeta('last_alert_cycle', status.cycleStart);
    store.setMeta('last_alert_level', 'ok');
  }

  const previous = store.getMeta('last_alert_level', 'ok');
  const rising = RANK[status.level] > RANK[previous];

  if (rising && (status.level === 'warn' || status.level === 'hit')) {
    await send(ntfy, {
      title: status.level === 'hit' ? 'Sip Club cap reached' : 'Sip Club running low',
      message:
        status.level === 'hit'
          ? `${status.used}/${status.cap} used. Period resets ${status.cycleEnd}.`
          : `${status.used}/${status.cap} used, ${status.remaining} left with ${status.daysLeft} days to go.`,
      priority: status.level === 'hit' ? 'high' : 'default',
      tags: status.level === 'hit' ? ['no_entry'] : ['warning'],
    });
    sent.push(status.level);
  }

  // Track the level even when it falls, so a later rise is a real transition.
  if (status.level !== previous) store.setMeta('last_alert_level', status.level);

  // Cooldown expiry: fire once per readyAt, and only when a drink is actually
  // available to claim.
  if (
    status.readyAt &&
    !status.cooling &&
    status.used < status.cap &&
    store.getMeta('last_cooldown_alert') !== status.readyAt
  ) {
    const expiredMs = now - new Date(status.readyAt).getTime();
    // Don't announce cooldowns that lapsed long ago (first run, or a gap in
    // polling) — only ones that expired within the last polling window.
    if (expiredMs >= 0 && expiredMs <= (opts.freshWindowMs ?? 30 * 60_000)) {
      await send(ntfy, {
        title: 'Next drink ready',
        message: `Cooldown expired. ${status.remaining} left this period.`,
        tags: ['coffee'],
      });
      sent.push('cooldown');
    }
    store.setMeta('last_cooldown_alert', status.readyAt);
  }

  return sent;
}

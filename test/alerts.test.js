import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, makeStore } from '../src/db.js';
import { buildStatus } from '../src/status.js';
import { maybeAlert } from '../src/alerts.js';

const ANCHOR = '2026-07-12';
const NTFY = { enabled: true, server: 'https://ntfy.test', topic: 't', token: '' };

/** Collects pushes instead of sending them. */
function recorder() {
  const sent = [];
  return {
    sent,
    publish: async (_cfg, msg) => {
      sent.push(msg);
      return { sent: true };
    },
  };
}

/** Seed `n` redemptions spread across the period, one per day from day 1. */
function storeWith(t, n, { lastAt } = {}) {
  const store = makeStore(openDb(':memory:'));
  t.after(() => store.close());
  const start = new Date('2026-08-11T12:00:00Z').getTime();
  for (let i = 0; i < n; i += 1) {
    store.insert({
      orderId: `o${i}`,
      occurredAt: new Date(start + i * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }
  if (lastAt) store.insert({ orderId: 'last', occurredAt: lastAt });
  return store;
}

test('Phase 5 acceptance: crossing 27 pushes exactly once', async (t) => {
  const now = new Date('2026-09-05T12:00:00Z').getTime();
  const store = storeWith(t, 27);
  const rec = recorder();

  const status = buildStatus(store, ANCHOR, now);
  assert.equal(status.level, 'warn');

  const first = await maybeAlert(store, status, { ntfy: NTFY, publish: rec.publish, now });
  assert.deepEqual(first, ['warn']);
  assert.equal(rec.sent.length, 1);

  // A second poll with unchanged state must stay silent.
  const second = await maybeAlert(store, buildStatus(store, ANCHOR, now), {
    ntfy: NTFY,
    publish: rec.publish,
    now,
  });
  assert.deepEqual(second, []);
  assert.equal(rec.sent.length, 1);
});

test('reaching the cap pushes again, because it is a new level', async (t) => {
  const now = new Date('2026-09-05T12:00:00Z').getTime();
  const store = storeWith(t, 27);
  const rec = recorder();

  await maybeAlert(store, buildStatus(store, ANCHOR, now), {
    ntfy: NTFY,
    publish: rec.publish,
    now,
  });

  for (let i = 0; i < 3; i += 1) {
    store.insert({ orderId: `extra${i}`, occurredAt: '2026-09-05T11:00:00Z' });
  }
  const hit = buildStatus(store, ANCHOR, now);
  assert.equal(hit.level, 'hit');

  const sent = await maybeAlert(store, hit, { ntfy: NTFY, publish: rec.publish, now });
  assert.deepEqual(sent, ['hit']);
  assert.equal(rec.sent.length, 2);
  assert.match(rec.sent[1].title, /cap reached/i);
});

test('a new period re-arms the threshold alerts', async (t) => {
  const rec = recorder();
  const store = storeWith(t, 27);
  const inPeriod = new Date('2026-09-05T12:00:00Z').getTime();
  await maybeAlert(store, buildStatus(store, ANCHOR, inPeriod), {
    ntfy: NTFY,
    publish: rec.publish,
    now: inPeriod,
  });
  assert.equal(rec.sent.length, 1);

  // Next period: the count resets to zero, so the stored "warn" must not
  // suppress the next genuine warning.
  const nextPeriod = new Date('2026-09-15T12:00:00Z').getTime();
  const fresh = buildStatus(store, ANCHOR, nextPeriod);
  assert.equal(fresh.used, 0);
  await maybeAlert(store, fresh, { ntfy: NTFY, publish: rec.publish, now: nextPeriod });
  assert.equal(store.getMeta('last_alert_level'), 'ok');
});

test('cooldown expiry pushes once, and only within the polling window', async (t) => {
  const lastAt = '2026-08-15T16:01:55Z';
  const store = storeWith(t, 5, { lastAt });
  const rec = recorder();

  // Ten minutes after the cooldown lapsed: fresh enough to announce.
  const now = new Date('2026-08-15T18:11:00Z').getTime();
  const sent = await maybeAlert(store, buildStatus(store, ANCHOR, now), {
    ntfy: NTFY,
    publish: rec.publish,
    now,
  });
  assert.deepEqual(sent, ['cooldown']);

  const again = await maybeAlert(store, buildStatus(store, ANCHOR, now), {
    ntfy: NTFY,
    publish: rec.publish,
    now,
  });
  assert.deepEqual(again, [], 'same readyAt must not re-announce');
});

test('a cooldown that lapsed days ago is not announced on first run', async (t) => {
  const store = storeWith(t, 5, { lastAt: '2026-08-12T16:00:00Z' });
  const rec = recorder();
  const now = new Date('2026-08-15T18:00:00Z').getTime();

  const sent = await maybeAlert(store, buildStatus(store, ANCHOR, now), {
    ntfy: NTFY,
    publish: rec.publish,
    now,
  });
  assert.deepEqual(sent, []);
});

test('no cooldown push once the cap is spent — there is nothing to claim', async (t) => {
  const store = storeWith(t, 29, { lastAt: '2026-08-15T16:01:55Z' });
  const rec = recorder();
  const now = new Date('2026-08-15T18:11:00Z').getTime();

  const status = buildStatus(store, ANCHOR, now);
  assert.equal(status.used, 30);
  const sent = await maybeAlert(store, status, { ntfy: NTFY, publish: rec.publish, now });
  assert.deepEqual(sent, ['hit'], 'the cap alert fires, the cooldown one does not');
});

test('publishing is skipped entirely when no topic is configured', async (t) => {
  const store = storeWith(t, 27);
  const now = new Date('2026-09-05T12:00:00Z').getTime();
  const rec = recorder();

  const sent = await maybeAlert(store, buildStatus(store, ANCHOR, now), {
    ntfy: { enabled: false },
    publish: rec.publish,
    now,
  });

  // The publisher must not run at all, and the return value must not claim a
  // push that never happened.
  assert.deepEqual(sent, []);
  assert.equal(rec.sent.length, 0);

  // The transition is still recorded, so enabling ntfy later does not replay
  // a backlog of stale alerts.
  assert.equal(store.getMeta('last_alert_level'), 'warn');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, makeStore } from '../src/db.js';
import { parseMessage } from '../src/parse.js';
import { PERIOD_REDEMPTIONS, asMessage } from './fixtures/emails.js';

function freshStore(t) {
  const store = makeStore(openDb(':memory:'));
  t.after(() => store.close());
  return store;
}

const rowsFromFixtures = () =>
  PERIOD_REDEMPTIONS.map((f) => {
    const p = parseMessage(asMessage(f));
    return { orderId: p.orderId, occurredAt: p.occurredAt, cafe: p.cafe, source: 'email' };
  });

test('Phase 1 acceptance: a second identical run inserts zero duplicates', (t) => {
  const store = freshStore(t);
  const rows = rowsFromFixtures();

  assert.equal(store.insertMany(rows), 6, 'first run inserts all six');
  assert.equal(store.insertMany(rows), 0, 'second run inserts nothing');
  assert.equal(store.countBetween('2026-08-11T00:00:00Z', '2026-09-10T00:00:00Z'), 6);
});

test('an interrupted run leaves the same row count as a clean one', (t) => {
  const rows = rowsFromFixtures();

  const interrupted = freshStore(t);
  // Simulate dying after three of six messages, then restarting from scratch.
  interrupted.insertMany(rows.slice(0, 3));
  interrupted.insertMany(rows);

  const clean = freshStore(t);
  clean.insertMany(rows);

  const window = ['2026-08-11T00:00:00Z', '2026-09-10T00:00:00Z'];
  assert.equal(interrupted.countBetween(...window), clean.countBetween(...window));
});

test('the window is half-open: period start counts, period end does not', (t) => {
  const store = freshStore(t);
  store.insert({ orderId: 'a', occurredAt: '2026-08-11T00:00:00Z' });
  store.insert({ orderId: 'b', occurredAt: '2026-09-09T23:59:59Z' });
  store.insert({ orderId: 'c', occurredAt: '2026-09-10T00:00:00Z' });

  assert.equal(store.countBetween('2026-08-11T00:00:00Z', '2026-09-10T00:00:00Z'), 2);
});

test('latest returns the most recent redemption regardless of insert order', (t) => {
  const store = freshStore(t);
  store.insert({ orderId: 'later', occurredAt: '2026-08-15T16:01:55Z' });
  store.insert({ orderId: 'earlier', occurredAt: '2026-08-11T22:24:31Z' });
  assert.equal(store.latest().order_id, 'later');
});

test('a manual entry and an email entry coexist and both count', (t) => {
  const store = freshStore(t);
  store.insert({ orderId: '6051716151604995', occurredAt: '2026-08-11T22:24:31Z' });
  store.insert({ orderId: 'manual-1', occurredAt: '2026-08-12T10:00:00Z', source: 'manual' });
  assert.equal(store.countBetween('2026-08-11T00:00:00Z', '2026-09-10T00:00:00Z'), 2);
});

test('meta round-trips and overwrites in place', (t) => {
  const store = freshStore(t);
  assert.equal(store.getMeta('last_poll_at', 'never'), 'never');
  store.setMeta('last_poll_at', '2026-08-15T17:40:00Z');
  store.setMeta('last_poll_at', '2026-08-15T17:50:00Z');
  assert.equal(store.getMeta('last_poll_at'), '2026-08-15T17:50:00Z');
});

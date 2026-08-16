import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, makeStore } from '../src/db.js';
import { buildServer } from '../src/api.js';
import { parseMessage } from '../src/parse.js';
import { PERIOD_REDEMPTIONS, asMessage } from './fixtures/emails.js';

const TOKEN = 'test-token-0123456789abcdef';
const ANCHOR = '2026-07-12';
const auth = { authorization: `Bearer ${TOKEN}` };

function seeded() {
  const store = makeStore(openDb(':memory:'));
  for (const f of PERIOD_REDEMPTIONS) {
    const p = parseMessage(asMessage(f));
    store.insert({ orderId: p.orderId, occurredAt: p.occurredAt, cafe: p.cafe, source: 'email' });
  }
  store.setMeta('last_poll_at', '2026-08-15T17:40:00Z');
  return store;
}

function server(t, store) {
  const app = buildServer(store, { token: TOKEN, anchorDate: ANCHOR });
  t.after(async () => {
    await app.close();
    store.close();
  });
  return app;
}

test('Phase 2 acceptance: GET /api/sip reports the fixture window', async (t) => {
  // Freeze time at the documented evaluation instant.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T17:52:00Z') });

  const app = server(t, seeded());

  const res = await app.inject({ method: 'GET', url: '/api/sip', headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.used, 6);
  assert.equal(body.cap, 30);
  assert.equal(body.remaining, 24);
  assert.equal(body.cycleStart, '2026-08-11');
  assert.equal(body.cycleEnd, '2026-09-09');
  assert.equal(body.day, 5);
  assert.equal(body.daysLeft, 25);
  assert.equal(body.pace, 36);
  assert.equal(body.lastAt, '2026-08-15T16:01:55Z');
  assert.equal(body.readyAt, '2026-08-15T18:01:55Z');
  assert.equal(body.cooling, true);
  assert.equal(body.level, 'pace');
  assert.equal(body.lastPollAt, '2026-08-15T17:40:00Z');
  assert.equal(body.staleMinutes, 12);
});

test('cooling flips to false once the two-hour window has passed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T18:02:00Z') });
  const app = server(t, seeded());

  const body = (await app.inject({ method: 'GET', url: '/api/sip', headers: auth })).json();
  assert.equal(body.cooling, false);
  assert.equal(body.readyAt, '2026-08-15T18:01:55Z');
});

test('requests without a valid bearer token are rejected', async (t) => {
  const app = server(t, seeded());

  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
    const res = await app.inject({ method: 'GET', url: '/api/sip', headers });
    assert.equal(res.statusCode, 401);
  }
});

test('health is reachable without a token and leaks nothing', async (t) => {
  const app = server(t, seeded());

  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('a manual redemption increments the count and is idempotent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T19:00:00Z') });
  const app = server(t, seeded());

  const post = () =>
    app.inject({
      method: 'POST',
      url: '/api/sip/manual',
      headers: auth,
      payload: { occurredAt: '2026-08-15T18:30:00Z' },
    });

  const first = await post();
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().created, true);
  assert.equal(first.json().status.used, 7);
  assert.equal(first.json().orderId, 'manual-1786818600000');

  // Re-posting the same instant must not double-count.
  const second = await post();
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().created, false);
  assert.equal(second.json().status.used, 7);
});

test('a manual redemption restarts the cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T19:00:00Z') });
  const app = server(t, seeded());

  await app.inject({
    method: 'POST',
    url: '/api/sip/manual',
    headers: auth,
    payload: { occurredAt: '2026-08-15T18:30:00Z' },
  });

  const body = (await app.inject({ method: 'GET', url: '/api/sip', headers: auth })).json();
  assert.equal(body.readyAt, '2026-08-15T20:30:00Z');
  assert.equal(body.cooling, true);
});

test('a malformed timestamp is rejected rather than stored as an epoch date', async (t) => {
  const app = server(t, seeded());

  const res = await app.inject({
    method: 'POST',
    url: '/api/sip/manual',
    headers: auth,
    payload: { occurredAt: 'yesterday-ish' },
  });
  assert.equal(res.statusCode, 400);
});

test('manual entries can be deleted; email-sourced ones cannot', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T19:00:00Z') });
  const app = server(t, seeded());

  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/sip/manual',
      headers: auth,
      payload: { occurredAt: '2026-08-15T18:30:00Z' },
    })
  ).json();

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/sip/manual/${created.orderId}`,
    headers: auth,
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().status.used, 6);

  // The next poll would just re-insert an email row, so refuse rather than
  // report a deletion that will not stick.
  const refused = await app.inject({
    method: 'DELETE',
    url: '/api/sip/manual/6051716151604995',
    headers: auth,
  });
  assert.equal(refused.statusCode, 400);

  const missing = await app.inject({
    method: 'DELETE',
    url: '/api/sip/manual/manual-1',
    headers: auth,
  });
  assert.equal(missing.statusCode, 404);
});

test('an empty database reports zero rather than failing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T17:52:00Z') });
  const app = server(t, makeStore(openDb(':memory:')));

  const body = (await app.inject({ method: 'GET', url: '/api/sip', headers: auth })).json();
  assert.equal(body.used, 0);
  assert.equal(body.remaining, 30);
  assert.equal(body.lastAt, null);
  assert.equal(body.readyAt, null);
  assert.equal(body.cooling, false);
  assert.equal(body.level, 'ok');
  assert.equal(body.staleMinutes, null, 'never polled is not the same as fresh');
});

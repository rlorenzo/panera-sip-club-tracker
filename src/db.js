import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS redemptions (
  order_id    TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  cafe        TEXT,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- Sip Club savings applied with nothing fully comped: possibly a food-only
  -- discount. Recorded so it survives log rotation and can be reconciled, but
  -- it does not affect the count. See docs/phase0-verification.md.
  needs_review INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_redemptions_occurred_at
  ON redemptions(occurred_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // The file holds a record of the operator's movements; keep it private.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort — a non-owner process still works, just less locked down */
  }
  return db;
}

export function makeStore(db) {
  const stmts = {
    // Ingestion is idempotent by order_id, so re-polling a window that
    // overlaps rows we already have is a no-op rather than a duplicate.
    insert: db.prepare(`
      INSERT INTO redemptions
        (order_id, occurred_at, cafe, source, created_at, needs_review)
      VALUES (@orderId, @occurredAt, @cafe, @source, @createdAt, @needsReview)
      ON CONFLICT(order_id) DO NOTHING
    `),
    deleteById: db.prepare('DELETE FROM redemptions WHERE order_id = ?'),
    getById: db.prepare('SELECT * FROM redemptions WHERE order_id = ?'),
    countBetween: db.prepare(`
      SELECT COUNT(*) AS n FROM redemptions
      WHERE occurred_at >= ? AND occurred_at < ?
    `),
    countReviewBetween: db.prepare(`
      SELECT COUNT(*) AS n FROM redemptions
      WHERE occurred_at >= ? AND occurred_at < ? AND needs_review = 1
    `),
    listBetween: db.prepare(`
      SELECT * FROM redemptions
      WHERE occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at ASC
    `),
    latest: db.prepare(`
      SELECT * FROM redemptions ORDER BY occurred_at DESC LIMIT 1
    `),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  };

  return {
    db,

    /** @returns {boolean} true when the row was new. */
    insert({ orderId, occurredAt, cafe = null, source = 'email', needsReview = false }) {
      const info = stmts.insert.run({
        orderId,
        occurredAt,
        cafe,
        source,
        createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        needsReview: needsReview ? 1 : 0,
      });
      return info.changes > 0;
    },

    insertMany(rows) {
      const run = this.db.transaction((batch) => {
        let inserted = 0;
        for (const row of batch) if (this.insert(row)) inserted += 1;
        return inserted;
      });
      return run(rows);
    },

    remove(orderId) {
      return stmts.deleteById.run(orderId).changes > 0;
    },

    get(orderId) {
      return stmts.getById.get(orderId) ?? null;
    },

    countBetween(startISO, endISO) {
      return stmts.countBetween.get(startISO, endISO).n;
    },

    countReviewBetween(startISO, endISO) {
      return stmts.countReviewBetween.get(startISO, endISO).n;
    },

    listBetween(startISO, endISO) {
      return stmts.listBetween.all(startISO, endISO);
    },

    latest() {
      return stmts.latest.get() ?? null;
    },

    getMeta(key, fallback = null) {
      return stmts.getMeta.get(key)?.value ?? fallback;
    },

    setMeta(key, value) {
      stmts.setMeta.run(key, String(value));
    },

    close() {
      if (this.db.open) this.db.close();
    },
  };
}

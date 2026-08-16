import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { openDb, makeStore } from './db.js';
import { buildStatus } from './status.js';

function tokensMatch(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first and
  // still run the comparison to keep the timing profile flat.
  return a.length === b.length && timingSafeEqual(a, b);
}

// Rejects the shapes that slip past `new Date()`: `new Date(1)` and
// `new Date([2026])` are both valid Dates, so a numeric or array occurredAt
// would otherwise store a redemption at an arbitrary instant.
const MANUAL_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    occurredAt: {
      type: 'string',
      // Full ISO 8601 instant. Stricter than Date parsing, which accepts
      // things like "1" and "2026" and quietly invents the missing parts.
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$',
    },
    cafe: { type: ['string', 'null'], maxLength: 200 },
  },
};

export function buildServer(store, opts = {}) {
  const token = opts.token ?? config.api.token;
  // An empty explicit override would sail past config's required() check and
  // 401 every request with no indication why.
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('API token must be a string of at least 16 characters');
  }
  const anchorDate = opts.anchorDate ?? config.anchorDate;
  const app = Fastify({
    logger: opts.logger ?? false,
    // Fastify's ajv defaults would defeat the schema below: coerceTypes turns
    // a numeric occurredAt into a string (and `new Date("1")` is a valid date,
    // which is the bug the schema exists to stop), and removeAdditional
    // silently strips unknown fields instead of rejecting them.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.register(rateLimit, {
    max: opts.rateMax ?? 120,
    timeWindow: '1 minute',
  });

  // Unauthenticated liveness only — no counts, no dates.
  app.get('/health', async () => ({ ok: true }));

  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions?.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !tokensMatch(given, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/sip', async () => buildStatus(store, anchorDate));

  app.post('/api/sip/manual', { schema: { body: MANUAL_BODY_SCHEMA } }, async (req, reply) => {
    const raw = req.body?.occurredAt ?? new Date().toISOString();
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) {
      return reply.code(400).send({ error: 'occurredAt must be an ISO 8601 timestamp' });
    }
    // A future timestamp would pin readyAt ahead of now and leave the widget
    // reading "cooling" until it passes. Small clock skew is tolerated.
    if (when.getTime() > Date.now() + 60_000) {
      return reply.code(400).send({ error: 'occurredAt cannot be in the future' });
    }

    const orderId = `manual-${when.getTime()}`;
    const created = store.insert({
      orderId,
      occurredAt: when.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      cafe: req.body?.cafe ?? null,
      source: 'manual',
    });

    return reply.code(created ? 201 : 200).send({
      orderId,
      created,
      status: buildStatus(store, anchorDate),
    });
  });

  app.delete('/api/sip/manual/:id', async (req, reply) => {
    const { id } = req.params;
    // Scoped to manual rows on purpose: email-sourced rows are reconstructible
    // from the mailbox, but deleting one here would just be re-inserted on the
    // next poll, so a success would be a lie.
    if (!id.startsWith('manual-')) {
      return reply.code(400).send({ error: 'only manual redemptions can be deleted' });
    }
    const removed = store.remove(id);
    if (!removed) return reply.code(404).send({ error: 'not found' });
    return { orderId: id, removed, status: buildStatus(store, anchorDate) };
  });

  return app;
}

if (import.meta.main) {
  const store = makeStore(openDb(config.dbPath));
  const app = buildServer(store, { logger: true });

  // systemd sends SIGTERM on restart and stop; drain in-flight requests and
  // close the SQLite handle rather than being killed mid-write.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      app.log.info(`${signal} received, shutting down`);
      await app.close().catch(() => {});
      store.close();
      process.exit(0);
    });
  }

  app.listen({ host: config.api.host, port: config.api.port }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

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

export function buildServer(store, opts = {}) {
  const token = opts.token ?? config.api.token;
  const anchorDate = opts.anchorDate ?? config.anchorDate;
  const app = Fastify({ logger: opts.logger ?? false });

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

  app.post('/api/sip/manual', async (req, reply) => {
    const raw = req.body?.occurredAt ?? new Date().toISOString();
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) {
      return reply.code(400).send({ error: 'occurredAt must be an ISO 8601 timestamp' });
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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const store = makeStore(openDb(config.dbPath));
  const app = buildServer(store, { logger: true });
  app
    .listen({ host: config.api.host, port: config.api.port })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

/**
 * Number('') is 0 and Number('http') is NaN, either of which would bind a
 * nonsense port or point IMAP at nothing. Take the default only when the
 * variable is genuinely absent.
 */
function port(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535, got: ${raw}`);
  }
  return n;
}

export const config = {
  root,
  dbPath: process.env.SIP_DB_PATH ?? join(root, 'data', 'sip.db'),
  anchorDate: process.env.SIP_ANCHOR_DATE ?? '2026-07-12',

  api: {
    host: process.env.SIP_HOST ?? '127.0.0.1',
    port: port('SIP_PORT', 8412),
    get token() {
      return required('SIP_TOKEN');
    },
  },

  imap: {
    host: process.env.IMAP_HOST ?? 'imap.gmail.com',
    port: port('IMAP_PORT', 993),
    mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
    get user() {
      return required('IMAP_USER');
    },
    get pass() {
      return required('IMAP_PASSWORD');
    },
  },

  sender: process.env.SIP_SENDER ?? 'panera@m2.panerabread.com',

  ntfy: {
    server: process.env.NTFY_SERVER ?? 'https://ntfy.sh',
    topic: process.env.NTFY_TOPIC ?? '',
    token: process.env.NTFY_TOKEN ?? '',
    timeoutMs: Number(process.env.NTFY_TIMEOUT_MS ?? 10_000),
    get enabled() {
      return Boolean(this.topic);
    },
  },
};

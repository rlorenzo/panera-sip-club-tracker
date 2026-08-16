import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export const config = {
  root,
  dbPath: process.env.SIP_DB_PATH ?? join(root, 'data', 'sip.db'),
  anchorDate: process.env.SIP_ANCHOR_DATE ?? '2026-07-12',

  api: {
    host: process.env.SIP_HOST ?? '127.0.0.1',
    port: Number(process.env.SIP_PORT ?? 8412),
    get token() {
      return required('SIP_TOKEN');
    },
  },

  imap: {
    host: process.env.IMAP_HOST ?? 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT ?? 993),
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
    get enabled() {
      return Boolean(this.topic);
    },
  },
};

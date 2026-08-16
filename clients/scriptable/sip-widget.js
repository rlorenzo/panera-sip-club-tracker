// Sip Ledger — Scriptable widget (iPhone)
//
// Setup:
//   1. Install Scriptable, create a new script, paste this in.
//   2. Set API_URL and TOKEN below.
//   3. Home screen → add a Scriptable widget → pick this script.
//
// Small and medium layouts are both supported; the widget picks by size.
// On a fetch failure the last good response is rendered dimmed with a stale
// marker rather than an error — a widget showing nothing is useless, but a
// widget silently showing yesterday's number is worse, so staleness is
// always visible.

const API_URL = 'https://sip.rexlorenzo.com/api/sip';
const TOKEN = 'REPLACE_ME';

const CACHE = FileManager.local();
const CACHE_PATH = CACHE.joinPath(CACHE.cacheDirectory(), 'sip-ledger.json');
const STALE_AFTER_MIN = 30;

const COLORS = {
  bg: new Color('#1c1c1e'),
  text: Color.white(),
  dim: new Color('#8e8e93'),
  ok: new Color('#30d158'),
  warn: new Color('#ff9f0a'),
  hit: new Color('#ff453a'),
  track: new Color('#3a3a3c'),
};

async function fetchStatus() {
  const req = new Request(API_URL);
  req.headers = { Authorization: `Bearer ${TOKEN}` };
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  CACHE.writeString(CACHE_PATH, JSON.stringify({ data, at: Date.now() }));
  return { data, stale: false };
}

function cached() {
  if (!CACHE.fileExists(CACHE_PATH)) return null;
  try {
    const { data, at } = JSON.parse(CACHE.readString(CACHE_PATH));
    return { data, stale: true, cachedMinutes: Math.floor((Date.now() - at) / 60000) };
  } catch {
    return null;
  }
}

function countColor(status) {
  if (status.level === 'hit' || status.level === 'warn') return COLORS.hit;
  if (status.level === 'pace') return COLORS.warn;
  return COLORS.text;
}

/** "READY" or a H:MM countdown to the next free drink. */
function cooldownText(status) {
  if (!status.cooling || !status.readyAt) return 'READY';
  const ms = new Date(status.readyAt).getTime() - Date.now();
  if (ms <= 0) return 'READY';
  const mins = Math.ceil(ms / 60000);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

function addBar(widget, status, segments) {
  const row = widget.addStack();
  row.spacing = 1;
  const fill = countColor(status);
  for (let i = 0; i < segments; i += 1) {
    const seg = row.addStack();
    seg.size = new Size(segments === 30 ? 6 : 9, 6);
    seg.cornerRadius = 1;
    seg.backgroundColor = i < Math.round((status.used / status.cap) * segments) ? fill : COLORS.track;
  }
}

function staleNote(widget, status, cachedMinutes) {
  const minutes = cachedMinutes ?? status.staleMinutes;
  if (minutes === null || minutes === undefined || minutes <= STALE_AFTER_MIN) return;
  const note = widget.addText(
    cachedMinutes === undefined ? `stale ${minutes}m` : `offline · ${minutes}m old`,
  );
  note.font = Font.systemFont(9);
  note.textColor = COLORS.warn;
}

function buildWidget({ data: status, stale, cachedMinutes }, family) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 12, 14);

  const header = w.addStack();
  const title = header.addText('SIP LEDGER');
  title.font = Font.mediumSystemFont(10);
  title.textColor = COLORS.dim;
  header.addSpacer();
  const day = header.addText(`day ${status.day}/30`);
  day.font = Font.mediumSystemFont(10);
  day.textColor = COLORS.dim;

  w.addSpacer(6);

  const count = w.addText(`${status.used} / ${status.cap}`);
  count.font = Font.boldSystemFont(family === 'small' ? 28 : 36);
  count.textColor = countColor(status);
  // Cached values are rendered dimmed so a stale widget never looks live.
  if (stale) count.textOpacity = 0.5;

  w.addSpacer(6);
  addBar(w, status, family === 'small' ? 15 : 30);
  w.addSpacer(6);

  const footer = w.addStack();
  const ready = footer.addText(
    family === 'small' ? cooldownText(status) : `next drink  ${cooldownText(status)}`,
  );
  ready.font = Font.systemFont(11);
  ready.textColor = status.cooling ? COLORS.dim : COLORS.ok;

  if (family !== 'small') {
    footer.addSpacer();
    const left = footer.addText(`${status.daysLeft}d left`);
    left.font = Font.systemFont(11);
    left.textColor = COLORS.dim;
  }

  staleNote(w, status, stale ? cachedMinutes : undefined);

  // Wake up near the moment the next drink becomes available; iOS treats this
  // as a hint, not a guarantee.
  w.refreshAfterDate =
    status.cooling && status.readyAt ? new Date(status.readyAt) : new Date(Date.now() + 900_000);

  return w;
}

let result;
try {
  result = await fetchStatus();
} catch (err) {
  result = cached();
  if (!result) {
    const w = new ListWidget();
    w.backgroundColor = COLORS.bg;
    const t = w.addText('Sip Ledger\nunreachable');
    t.font = Font.systemFont(12);
    t.textColor = COLORS.warn;
    Script.setWidget(w);
    Script.complete();
    throw err;
  }
}

const widget = buildWidget(result, config.widgetFamily ?? 'medium');
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();

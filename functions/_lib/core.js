// Общие функции: база заявок (Cloudflare D1), форматирование, вызовы Telegram API.
// Файл лежит в _lib и сам по себе адресом сайта не становится.

export const STATUSES = {
  new:   { icon: '🆕', label: 'Новая',          short: 'Новые' },
  work:  { icon: '🔥', label: 'В работе',       short: 'В работе' },
  quote: { icon: '📄', label: 'КП отправлено',  short: 'КП' },
  won:   { icon: '✅', label: 'Продано',        short: 'Продано' },
  lost:  { icon: '❌', label: 'Отказ',          short: 'Отказ' },
};
export const ORDER = ['new', 'work', 'quote', 'won', 'lost'];
export const RETENTION_DAYS = 913; // 2,5 года, как в политике конфиденциальности

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const clipText = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const fmtNum = (n) => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');

const MSK = 3 * 3600 * 1000;
export const fmtTime = (ms) => { const d = new Date(ms + MSK).toISOString(); return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`; };
export const dayKey = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
export const mskHour = (ms) => new Date(ms + MSK).getUTCHours();
export function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'меньше минуты';
  if (m < 60) return `${m} мин`;
  if (m < 48 * 60) return `${Math.round(m / 60)} ч`;
  return `${Math.round(m / 1440)} дн`;
}

// ---------- CSV (для выгрузки из бота) ----------
export function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  s = s.replace(/\r?\n/g, ' / ');
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export const csvLine = (cells) => cells.map(csvCell).join(';');

// ---------- База ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, created INTEGER NOT NULL, type TEXT, name TEXT, phone TEXT, email TEXT, promo TEXT,
    comment TEXT, volume REAL DEFAULT 0, sum REAL DEFAULT 0, text TEXT, consent_at TEXT,
    status TEXT NOT NULL DEFAULT 'new', assignee INTEGER, assignee_name TEXT, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS leads_status ON leads(status, created)`,
  `CREATE TABLE IF NOT EXISTS staff (tg_id INTEGER PRIMARY KEY, name TEXT, role TEXT NOT NULL DEFAULT 'manager', active INTEGER NOT NULL DEFAULT 1, added INTEGER)`,
  `CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, role TEXT, expires INTEGER, created_by INTEGER)`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT, ts INTEGER, who TEXT, kind TEXT, text TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_lead ON events(lead_id, id)`,
  `CREATE TABLE IF NOT EXISTS notifs (lead_id TEXT, chat_id INTEGER, msg_id INTEGER, PRIMARY KEY (lead_id, chat_id))`,
  `CREATE TABLE IF NOT EXISTS pending (tg_id INTEGER PRIMARY KEY, action TEXT, arg TEXT, ts INTEGER)`,
];
let ready = null;
export async function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready = null; throw e; });
  await ready;
}
export const q1 = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
export const qa = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
export const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

export const addEvent = (db, leadId, who, kind, text, ts = Date.now()) =>
  run(db, 'INSERT INTO events(lead_id, ts, who, kind, text) VALUES(?,?,?,?,?)', leadId, ts, who, kind, text);

// Новая заявка. Возвращает строку заявки, а если такой номер уже есть (повторная отправка) — null.
export async function insertLead(db, d, now = Date.now()) {
  const r = await run(db,
    `INSERT OR IGNORE INTO leads(id, created, type, name, phone, email, promo, comment, volume, sum, text, consent_at, status, updated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'new', ?)`,
    d.id, now, d.type, d.name, d.phone, d.email, d.promo, d.comment, d.volume, d.sum, d.text, d.consent_at, now);
  if (!r.meta || !r.meta.changes) return null;
  await addEvent(db, d.id, 'Сайт', 'create', 'Заявка получена', now);
  return q1(db, 'SELECT * FROM leads WHERE id = ?', d.id);
}

// Удаление всего, что старше срока хранения
export async function purgeOld(db, now = Date.now()) {
  const cut = now - RETENTION_DAYS * 86400000;
  await run(db, 'DELETE FROM events WHERE lead_id IN (SELECT id FROM leads WHERE created < ?)', cut);
  await run(db, 'DELETE FROM notifs WHERE lead_id IN (SELECT id FROM leads WHERE created < ?)', cut);
  await run(db, 'DELETE FROM leads WHERE created < ?', cut);
  await run(db, 'DELETE FROM invites WHERE expires < ?', now);
}

// ---------- Telegram ----------
export async function tg(env, method, body, isForm = false) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, isForm
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
export const adminIds = (env) => new Set(String(env.TG_ADMIN_IDS || '').split(',').map((s) => +s.trim()).filter(Boolean));

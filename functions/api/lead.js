// Cloudflare Pages Function: POST /api/lead
// Принимает заявки с сайта, проверяет их и отдаёт ТОЛЬКО владельцу сайта:
//   1) в рабочую базу заявок (Cloudflare D1, привязка DB) + мгновенное уведомление сотрудникам в Telegram-боте (панель: functions/api/tg.js);
//   2) копией (архивом) на Яндекс Диск, если задан YADISK_TOKEN.
// Секреты и привязки задаются в панели Cloudflare, в код не записываются (подробно: TELEGRAM-BOT.md и SECURITY.md):
//   TURNSTILE_SECRET, ALLOWED_ORIGINS, DB (база D1), TG_BOT_TOKEN, TG_WEBHOOK_SECRET, TG_ADMIN_IDS, YADISK_TOKEN
//   TG_CHAT_ID — (необязательно, запасной путь) если база недоступна, полная заявка уйдёт в этот чат
//   FORWARD_URL, FORWARD_TOKEN — (необязательно) адрес вашего собственного сервера / CRM

import { ensureSchema, insertLead, purgeOld } from '../_lib/core.js';
import { notifyNewLead } from '../_lib/ui.js';

const MAX_BODY = 20000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n) : '');
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function validate(p) {
  const out = {
    id: clip(p.id, 20),
    type: clip(p.type, 120),
    name: clip(p.name, 150),
    phone: clip(p.phone, 40),
    email: clip(p.email, 120),
    promo: clip(p.promo, 40),
    comment: clip(p.comment, 2000),
    consent_at: clip(p.consent_at, 40),
    volume: Number.isFinite(+p.volume) ? +p.volume : 0,
    sum: Number.isFinite(+p.sum) ? +p.sum : 0,
    text: clip(p.text, 6000),
    items: [],
  };
  if (!/^AS-[A-Z0-9]{4,10}$/.test(out.id)) return { error: 'bad_id' };
  if (out.name.length < 2) return { error: 'bad_name' };
  if (out.phone.replace(/\D/g, '').length < 10 || !/^[0-9+()\-\s]{10,40}$/.test(out.phone)) return { error: 'bad_phone' };
  if (out.email && !/^[^\s@<>]{1,64}@[^\s@<>]{1,255}\.[^\s@<>]{2,}$/.test(out.email)) return { error: 'bad_email' };
  if (Array.isArray(p.items)) {
    out.items = p.items.slice(0, 50).map((i) => ({
      name: clip(i && i.name, 120),
      size: clip(i && i.size, 120),
      opt: clip(i && i.opt, 300),
      payText: clip(i && i.payText, 120),
      q: Number.isFinite(+(i && i.q)) ? +i.q : 0,
      vt: Number.isFinite(+(i && i.vt)) ? +i.vt : 0,
    }));
  }
  return { ok: out };
}

export function formatMessage(d) {
  const lines = [
    `<b>Новая заявка ${escHtml(d.id)}</b>`,
    escHtml(d.type),
    '',
    `Имя: ${escHtml(d.name)}`,
    `Телефон: ${escHtml(d.phone)}`,
  ];
  if (d.email) lines.push(`Email: ${escHtml(d.email)}`);
  if (d.promo) lines.push(`Промокод: ${escHtml(d.promo)}`);
  if (d.comment) lines.push(`Комментарий: ${escHtml(d.comment)}`);
  if (d.volume) lines.push(`Объём: ${d.volume} м³`);
  if (d.sum) lines.push(`Сумма: ${d.sum} ₽`);
  if (d.text) lines.push('', escHtml(d.text));
  return lines.join('\n').slice(0, 4000);
}

export function formatShort(d) {
  return `<b>Новая заявка ${escHtml(d.id)}</b>\n${escHtml(d.type)}\nПодробности — на Яндекс Диске, в папке «Заявки».`;
}


// ---------- Яндекс Диск ----------
const DISK = 'https://cloud-api.yandex.net/v1/disk';
const FOLDER = 'app:/Заявки';            // папка внутри «папки приложения» (токен имеет доступ только к ней)
const SUMMARY = `${FOLDER}/Заявки.csv`;  // сводный файл
const RETENTION_DAYS = 913;              // 2,5 года
const CSV_HEAD = ['Получено', '№ заявки', 'Тип', 'Имя', 'Телефон', 'Email', 'Промокод', 'Комментарий', 'Объём, м³', 'Сумма, ₽', 'Состав заказа', 'Согласие дано'];
const BOM = '﻿'; // чтобы Excel и Таблицы правильно читали кириллицу

// Ячейка CSV: в кавычках, без переводов строк; «=», «+», «-», «@» в начале получают апостроф (защита от формул)
export function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  s = s.replace(/\r?\n/g, ' / ');
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export const csvLine = (cells) => cells.map(csvCell).join(';');

// Дата и время по Москве: «2026-10-17 19:13»
export function moscowStamp(ms = Date.now()) {
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export function leadRow(d, stamp) {
  return [stamp, d.id, d.type, d.name, d.phone, d.email, d.promo, d.comment, d.volume, d.sum, d.text, d.consent_at];
}

const auth = (env) => ({ Authorization: `OAuth ${env.YADISK_TOKEN}` });
const q = (o) => new URLSearchParams(o).toString();

async function diskUpload(env, path, text, overwrite) {
  const r = await fetch(`${DISK}/resources/upload?${q({ path, overwrite: overwrite ? 'true' : 'false' })}`, { headers: auth(env) });
  if (!r.ok) return false;
  const { href } = await r.json();
  if (!href) return false;
  const put = await fetch(href, { method: 'PUT', body: new TextEncoder().encode(text) });
  return put.status === 201 || put.status === 202;
}

// null — файла ещё нет; false — ошибка; строка — содержимое
async function diskRead(env, path) {
  const r = await fetch(`${DISK}/resources/download?${q({ path })}`, { headers: auth(env) });
  if (r.status === 404) return null;
  if (!r.ok) return false;
  const { href } = await r.json();
  const f = await fetch(href);
  if (!f.ok) return false;
  return await f.text();
}

async function diskEnsureFolder(env) {
  await fetch(`${DISK}/resources?${q({ path: 'app:/Заявки' })}`, { method: 'PUT', headers: auth(env) }).catch(() => null); // 201 создана, 409 уже есть
}

// Сохранить заявку: отдельный файл (главное) + строка в сводном файле (удобство)
export async function saveToDisk(env, d, now = Date.now()) {
  const stamp = moscowStamp(now);
  const line = csvLine(leadRow(d, stamp));
  await diskEnsureFolder(env);
  const fname = `${stamp.slice(0, 10)}_${stamp.slice(11, 13)}${stamp.slice(14, 16)}_${d.id}.csv`;
  const single = BOM + csvLine(CSV_HEAD) + '\r\n' + line + '\r\n';
  const ok = await diskUpload(env, `${FOLDER}/${fname}`, single, false).catch(() => false);
  if (!ok) return false;
  // сводный файл: добавляем строку и заодно убираем записи старше срока хранения. Ошибка здесь не критична: заявка уже сохранена
  try {
    const cur = await diskRead(env, SUMMARY);
    if (cur !== false) {
      const cutoff = moscowStamp(now - RETENTION_DAYS * 86400000).slice(0, 10);
      const lines = (cur ? cur.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean) : [csvLine(CSV_HEAD)]);
      const kept = lines.filter((l, i) => i === 0 || !/^"\d{4}-\d{2}-\d{2}/.test(l) || l.slice(1, 11) >= cutoff);
      kept.push(line);
      await diskUpload(env, SUMMARY, BOM + kept.join('\r\n') + '\r\n', true);
    }
  } catch (e) { /* пропускаем */ }
  return true;
}

// Удаляем файлы заявок старше срока хранения (вызывается после каждой новой заявки)
export async function purgeDisk(env, now = Date.now()) {
  const cutoff = moscowStamp(now - RETENTION_DAYS * 86400000).slice(0, 10);
  const r = await fetch(`${DISK}/resources?${q({ path: 'app:/Заявки', limit: '1000', fields: '_embedded.items.name,_embedded.items.path,_embedded.items.type' })}`, { headers: auth(env) });
  if (!r.ok) return 0;
  const j = await r.json();
  const items = (j._embedded && j._embedded.items) || [];
  let n = 0;
  for (const it of items) {
    const m = /^(\d{4}-\d{2}-\d{2})_\d{4}_AS-[A-Z0-9]+\.csv$/.exec(it.name || '');
    if (it.type === 'file' && m && m[1] < cutoff) {
      const del = await fetch(`${DISK}/resources?${q({ path: it.path, permanently: 'true' })}`, { method: 'DELETE', headers: auth(env) });
      if (del.ok) n++;
    }
  }
  return n;
}

async function verifyTurnstile(token, secret, ip) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  return !!j.success;
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  const later = (p) => (typeof ctx.waitUntil === 'function' ? ctx.waitUntil(p) : p);
  // 1. Только с нашего сайта
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  if (!allowed.length || !allowed.includes(origin)) return json({ ok: false, error: 'forbidden' }, 403);

  // 2. Формат и размер
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ ok: false, error: 'bad_type' }, 415);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
  let p;
  try { p = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  if (!p || typeof p !== 'object') return json({ ok: false, error: 'bad_json' }, 400);

  // 3. Невидимая капча Turnstile — обязательна. Без секрета заявки НЕ принимаются (защита не должна молча отключаться)
  if (!env.TURNSTILE_SECRET) return json({ ok: false, error: 'not_configured' }, 503);
  const human = await verifyTurnstile(clip(p.cf_token, 2048), env.TURNSTILE_SECRET, request.headers.get('CF-Connecting-IP'));
  if (!human) return json({ ok: false, error: 'captcha' }, 403);

  // 4. Согласие на обработку данных и проверка полей
  if (p.consent !== true) return json({ ok: false, error: 'consent' }, 400);
  const v = validate(p);
  if (v.error) return json({ ok: false, error: v.error }, 400);
  const d = v.ok;

  // 5. Доставка владельцу
  let delivered = false;
  const now = Date.now();

  // 5а. Рабочая база + уведомление сотрудникам в Telegram
  const dbJob = (async () => {
    if (!env.DB) return false;
    try {
      await ensureSchema(env.DB);
      const lead = await insertLead(env.DB, d, now); // null — такая заявка уже есть (повторная отправка)
      if (lead) await notifyNewLead(env, lead).catch(() => false);
      later(purgeOld(env.DB).catch(() => 0));
      return true;
    } catch (e) { return false; }
  })();

  // 5б. Копия-архив на Яндекс Диске
  const diskJob = (async () => {
    if (!env.YADISK_TOKEN) return false;
    const ok = await saveToDisk(env, d).catch(() => false);
    if (ok) later(purgeDisk(env).catch(() => 0));
    return ok;
  })();

  const [stored, archived] = await Promise.all([dbJob, diskJob]);
  if (stored || archived) delivered = true;

  // 5в. Запасной путь: базы нет или она не ответила — полная заявка в служебный чат Telegram, чтобы ничего не потерялось
  if (!stored && env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: formatMessage(d), parse_mode: 'HTML', disable_web_page_preview: true }),
    }).catch(() => null);
    if (r && r.ok) delivered = true;
  }
  if (env.FORWARD_URL) {
    const r = await fetch(env.FORWARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.FORWARD_TOKEN || ''}` },
      body: JSON.stringify(d),
    }).catch(() => null);
    if (r && r.ok) delivered = true;
  }
  if (!delivered) return json({ ok: false, error: 'delivery' }, 502);
  return json({ ok: true, id: d.id });
}

// Все остальные методы запрещены
export const onRequest = () => json({ ok: false, error: 'method' }, 405);

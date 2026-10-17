// Cloudflare Pages Function: /api/tg — вебхук Telegram-бота «Аманда Север · заявки».
// Панель менеджера: список заявок, статусы, «взять в работу», заметки, поиск, сводка, команда, выгрузка.
// Секреты и привязки: см. TELEGRAM-BOT.md (TG_BOT_TOKEN, TG_WEBHOOK_SECRET, TG_ADMIN_IDS, база DB).
import {
  STATUSES, ORDER, esc, clipText, fmtNum, fmtTime, dayKey, mskHour, span, csvLine, ensureSchema,
  q1, qa, run, addEvent, tg, adminIds, RETENTION_DAYS,
} from '../_lib/core.js';
import { btn, chunk, loadCard, refreshNotifs } from '../_lib/ui.js';

const PAGE = 6;
const OVERDUE_MS = 2 * 3600 * 1000;
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// ---------- Одноразовая настройка: открыть в браузере /api/tg?key=<TG_WEBHOOK_SECRET> ----------
export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || u.searchParams.get('key') !== env.TG_WEBHOOK_SECRET) return json({ ok: false }, 403);
  const hook = await tg(env, 'setWebhook', { url: `${u.origin}/api/tg`, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  const cmds = await tg(env, 'setMyCommands', { commands: [
    { command: 'start', description: 'Открыть панель' }, { command: 'new', description: 'Новые заявки' },
    { command: 'my', description: 'Мои заявки' }, { command: 'stats', description: 'Сводка' }, { command: 'find', description: 'Найти заявку' },
  ] });
  await tg(env, 'setMyShortDescription', { short_description: 'Заявки с сайта Аманда-Север: статусы, менеджеры, сводка' });
  const me = await tg(env, 'getMe', {});
  return json({ webhook: !!hook.ok, commands: !!cmds.ok, bot: me.ok ? '@' + me.result.username : null, database: !!env.DB, admins: adminIds(env).size });
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  let up;
  try { up = await request.json(); } catch (e) { return new Response('ok'); }
  try {
    if (!env.DB) throw new Error('Нет привязки базы DB (см. TELEGRAM-BOT.md)');
    await ensureSchema(env.DB);
    await handle(ctx, up);
  } catch (e) { console.error('tg error', e && e.stack || e); }
  return new Response('ok'); // Telegram всегда получает 200, иначе будет повторять запрос
}
export const onRequest = () => json({ ok: false, error: 'method' }, 405);

// ---------- Доступ ----------
const fullName = (f) => [f.first_name, f.last_name].filter(Boolean).join(' ') || f.username || String(f.id);
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function authorize(env, from, text) {
  const db = env.DB, name = fullName(from), now = Date.now();
  if (adminIds(env).has(from.id)) {
    await run(db, `INSERT INTO staff(tg_id, name, role, active, added) VALUES(?,?, 'admin', 1, ?)
                   ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, role = 'admin', active = 1`, from.id, name, now);
    return { id: from.id, name, role: 'admin' };
  }
  const m = /^\/start\s+inv_([a-f0-9]{16,64})/.exec(text || '');
  if (m) {
    const inv = await q1(db, 'SELECT code, role FROM invites WHERE code = ? AND expires > ?', m[1], now);
    if (inv) {
      await run(db, `INSERT INTO staff(tg_id, name, role, active, added) VALUES(?,?,?,1,?)
                     ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, role = excluded.role, active = 1`, from.id, name, inv.role, now);
      await run(db, 'DELETE FROM invites WHERE code = ?', inv.code);
      return { id: from.id, name, role: inv.role, joined: true };
    }
  }
  const s = await q1(db, 'SELECT tg_id, name, role FROM staff WHERE tg_id = ? AND active = 1', from.id);
  return s ? { id: s.tg_id, name: s.name, role: s.role } : null;
}

// ---------- Отправка / редактирование ----------
async function show(env, t, v) {
  const body = { chat_id: t.chat, text: v.text, ...HTML, reply_markup: { inline_keyboard: v.kb || [] } };
  if (t.mid) {
    const r = await tg(env, 'editMessageText', { ...body, message_id: t.mid });
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }
  await tg(env, 'sendMessage', body);
}

// ---------- Представления ----------
const homeRow = [btn('🏠 Меню', 'm')];
const bar = (c, max) => { const n = max ? Math.round((c / max) * 10) : 0; return '▰'.repeat(n) + '▱'.repeat(10 - n); };
const SPARK = '▁▂▃▄▅▆▇█';
const plural = (n) => { const m = n % 100, d = n % 10; return `${n} ${m > 10 && m < 15 ? 'заявок' : d === 1 ? 'заявка' : d >= 2 && d <= 4 ? 'заявки' : 'заявок'}`; };

async function counts(db) {
  const o = {}; for (const s of ORDER) o[s] = 0;
  for (const r of await qa(db, 'SELECT status, COUNT(*) c FROM leads GROUP BY status')) o[r.status] = r.c;
  return o;
}

async function menuView(db, me) {
  const now = Date.now(), c = await counts(db);
  const recent = await qa(db, 'SELECT created FROM leads WHERE created >= ?', now - 7 * 86400000);
  const today = recent.filter((r) => dayKey(r.created) === dayKey(now)).length;
  const mine = (await q1(db, "SELECT COUNT(*) c FROM leads WHERE assignee = ? AND status IN ('work','quote')", me.id)).c;
  const h = mskHour(now), hi = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const stale = (await q1(db, "SELECT COUNT(*) c FROM leads WHERE status = 'new' AND created < ?", now - OVERDUE_MS)).c;
  const text = [
    `🌲 <b>Аманда Север · заявки</b>`, '',
    `${hi}, ${esc(me.name.split(' ')[0])}!`, '',
    `🆕 Новых: <b>${c.new}</b>${stale ? `   ⏰ ждут больше 2 ч: <b>${stale}</b>` : ''}`,
    `🔥 В работе: <b>${c.work}</b>   📄 КП: <b>${c.quote}</b>`,
    `🙋 На вас: <b>${mine}</b>`, '',
    `📅 Сегодня: ${today}   ·   за 7 дней: ${recent.length}`,
  ].join('\n');
  const kb = [
    [btn(`🆕 Новые · ${c.new}`, 'ls:new:0'), btn(`🔥 В работе · ${c.work}`, 'ls:work:0')],
    [btn(`📄 КП · ${c.quote}`, 'ls:quote:0'), btn('🙋 Мои', 'ls:mine:0')],
    [btn('📋 Все заявки', 'ls:all:0'), btn('🔍 Поиск', 'f')],
    [btn('📊 Сводка', 'st')],
  ];
  if (me.role === 'admin') kb.push([btn('👥 Команда', 'tm'), btn('📥 Выгрузка CSV', 'ex')]);
  return { text, kb };
}

const FILTER_TITLE = { all: '📋 Все заявки', mine: '🙋 Мои заявки' };
function leadRowBtn(l, now = Date.now()) {
  const late = l.status === 'new' && now - l.created > OVERDUE_MS ? '⏰' : '';
  const vol = l.volume ? ` · ${l.volume} м³` : '';
  return [btn(`${STATUSES[l.status].icon}${late} ${l.id.slice(3)} · ${clipText(l.name, 16)}${vol}`, `l:${l.id}`)];
}

async function listView(db, me, filter, page) {
  const now = Date.now(), c = await counts(db);
  let where = '1=1', args = [], title;
  if (ORDER.includes(filter)) { where = 'status = ?'; args = [filter]; title = `${STATUSES[filter].icon} ${STATUSES[filter].label}`; }
  else if (filter === 'mine') { where = 'assignee = ?'; args = [me.id]; title = FILTER_TITLE.mine; }
  else { filter = 'all'; title = FILTER_TITLE.all; }
  const total = (await q1(db, `SELECT COUNT(*) c FROM leads WHERE ${where}`, ...args)).c;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const order = filter === 'new' ? 'created ASC' : 'created DESC';
  const rows = await qa(db, `SELECT * FROM leads WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, PAGE, page * PAGE);
  const text = total
    ? `<b>${title}</b> · ${total}\n${filter === 'new' ? 'Сначала самые старые: их надо обработать первыми.' : 'Сначала самые свежие.'}${pages > 1 ? `\nСтраница ${page + 1} из ${pages}` : ''}`
    : `<b>${title}</b>\n\nЗдесь пока пусто. ${filter === 'new' ? 'Как только клиент оставит заявку на сайте, вы получите уведомление 🔔' : ''}`;
  const kb = rows.map((l) => leadRowBtn(l, now));
  if (pages > 1) kb.push([btn('‹', `ls:${filter}:${page - 1}`), btn(`${page + 1}/${pages}`, `ls:${filter}:${page}`), btn('›', `ls:${filter}:${page + 1}`)]);
  kb.push(ORDER.map((s) => btn(`${filter === s ? '•' : ''}${STATUSES[s].icon}${c[s]}`, `ls:${s}:0`)));
  kb.push([btn(filter === 'all' ? '• Все' : 'Все', 'ls:all:0'), btn(filter === 'mine' ? '• Мои' : 'Мои', 'ls:mine:0'), ...homeRow]);
  return { text, kb };
}

async function statsView(db) {
  const now = Date.now(), c = await counts(db);
  const total = ORDER.reduce((a, s) => a + c[s], 0);
  if (!total) return { text: '📊 <b>Сводка</b>\n\nДанных пока нет: первая заявка всё запустит.', kb: [homeRow] };
  const rows = await qa(db, 'SELECT created, status, volume, sum FROM leads WHERE created >= ?', now - 30 * 86400000);
  const days = []; for (let i = 6; i >= 0; i--) days.push(dayKey(now - i * 86400000));
  const per = days.map((d) => rows.filter((r) => dayKey(r.created) === d).length);
  const mx = Math.max(...per, 1);
  const spark = per.map((n) => (n ? SPARK[Math.min(7, Math.ceil((n / mx) * 7))] : '▁')).join('');
  const week = per.reduce((a, b) => a + b, 0);
  const won = rows.filter((r) => r.status === 'won');
  const closed = c.won + c.lost;
  const conv = closed ? Math.round((c.won / closed) * 100) : null;
  const resp = await q1(db, `SELECT AVG(e.ts - l.created) a FROM leads l
    JOIN (SELECT lead_id, MIN(ts) ts FROM events WHERE kind IN ('status','assign') GROUP BY lead_id) e ON e.lead_id = l.id WHERE l.created >= ?`, now - 30 * 86400000);
  const maxC = Math.max(...ORDER.map((s) => c[s]), 1);
  const L = ['📊 <b>Сводка</b>', '',
    `<b>7 дней</b>   <code>${spark}</code>   ${plural(week)}`,
    `Сегодня ${per[6]}  ·  за 30 дней ${rows.length}  ·  всего ${total}`, '', '<b>По статусам</b>'];
  for (const s of ORDER) L.push(`${STATUSES[s].icon} <code>${bar(c[s], maxC)}</code> ${c[s]}`);
  L.push('');
  if (conv !== null) L.push(`🎯 Конверсия в «Продано»: <b>${conv}%</b> (${c.won} из ${closed} закрытых)`);
  if (resp && resp.a) L.push(`⏱ Среднее время до первой реакции (30 дн.): <b>${span(resp.a)}</b>`);
  const v = won.reduce((a, r) => a + (r.volume || 0), 0), s = won.reduce((a, r) => a + (r.sum || 0), 0);
  if (won.length) L.push(`💰 Продано за 30 дней: <b>${won.length}</b> шт., ${Math.round(v * 100) / 100} м³${s ? `, ${fmtNum(s)} ₽` : ''}`);
  const inWork = await q1(db, "SELECT COALESCE(SUM(volume),0) v FROM leads WHERE status IN ('new','work','quote')");
  if (inWork.v) L.push(`🪵 Объём в воронке: <b>${Math.round(inWork.v * 100) / 100} м³</b>`);
  return { text: L.join('\n'), kb: [[btn('🔄 Обновить', 'st'), ...homeRow]] };
}

async function teamView(db, note) {
  const st = await qa(db, 'SELECT tg_id, name, role, active FROM staff ORDER BY role, name');
  const L = ['👥 <b>Команда</b>', ''];
  for (const s of st) L.push(`${s.active ? '🟢' : '⚪️'} ${esc(s.name)} — ${s.role === 'admin' ? 'администратор' : 'менеджер'}`);
  if (note) L.push('', note);
  const kb = st.filter((s) => s.role !== 'admin').map((s) => [btn(`${s.active ? '🚫 Отключить' : '✅ Вернуть'} · ${clipText(s.name, 20)}`, `tx:${s.tg_id}`)]);
  kb.push([btn('➕ Пригласить менеджера', 'inv')], homeRow);
  return { text: L.join('\n'), kb };
}

let botName = null;
async function botUsername(env) {
  if (botName) return botName;
  const r = await tg(env, 'getMe', {});
  return (botName = r.ok ? r.result.username : null);
}

async function searchView(db, qtext) {
  const raw = qtext.trim().slice(0, 60), like = '%' + raw.replace(/[\\%_]/g, '\\$&') + '%';
  const digits = raw.replace(/\D/g, '');
  const ph = digits.length >= 4 ? "OR replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+','') LIKE ? ESCAPE '\\'" : '';
  const args = [like, like, like]; if (ph) args.push('%' + digits + '%');
  const rows = await qa(db, `SELECT * FROM leads WHERE id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ${ph} ORDER BY created DESC LIMIT 8`, ...args);
  const text = rows.length ? `🔍 Найдено: <b>${rows.length}</b> по запросу «${esc(raw)}»` : `🔍 По запросу «${esc(raw)}» ничего не нашлось.\nИщите по номеру заявки, имени, телефону или email.`;
  return { text, kb: [...rows.map((l) => leadRowBtn(l)), homeRow] };
}

// ---------- Действия ----------
async function setStatus(db, me, id, status) {
  const l = await q1(db, 'SELECT status, assignee FROM leads WHERE id = ?', id);
  if (!l || !STATUSES[status]) return null;
  const now = Date.now();
  if (status === 'work' && !l.assignee) await run(db, 'UPDATE leads SET status = ?, assignee = ?, assignee_name = ?, updated = ? WHERE id = ?', status, me.id, me.name, now, id);
  else await run(db, 'UPDATE leads SET status = ?, updated = ? WHERE id = ?', status, now, id);
  await addEvent(db, id, me.name, 'status', `${STATUSES[status].icon} ${STATUSES[status].label}`, now);
  return true;
}

// ---------- Маршрутизация ----------
async function handle(ctx, up) {
  const { env } = ctx, db = env.DB;
  const cb = up.callback_query, msg = up.message;
  const from = cb ? cb.from : msg && msg.from;
  const chat = cb ? cb.message && cb.message.chat : msg && msg.chat;
  if (!from || !chat || chat.type !== 'private') return;
  const bg = (p) => (ctx.waitUntil ? ctx.waitUntil(p) : p);
  const t = { chat: chat.id, mid: cb && cb.message.message_id };

  const me = await authorize(env, from, msg && msg.text);
  if (!me) {
    if (cb) await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа', show_alert: true });
    else await tg(env, 'sendMessage', { chat_id: chat.id, ...HTML, text: `🔒 <b>Доступ закрыт</b>\n\nЭто рабочий бот компании «Аманда-Север». Чтобы получить доступ, отправьте администратору ссылку-приглашение или свой номер ID: <code>${from.id}</code>` });
    return;
  }

  if (cb) {
    const toast = await onCallback({ env, db, me, t, bg }, cb.data || '');
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, ...(toast ? { text: toast } : {}) });
    return;
  }
  const text = (msg.text || '').trim();
  if (!text) return;
  const c = { env, db, me, t: { chat: chat.id }, bg };

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.split(/\s+/); const arg = rest.join(' ');
    await run(db, 'DELETE FROM pending WHERE tg_id = ?', me.id);
    const name = cmd.toLowerCase().split('@')[0];
    if (name === '/new') return show(env, c.t, await listView(db, me, 'new', 0));
    if (name === '/my') return show(env, c.t, await listView(db, me, 'mine', 0));
    if (name === '/stats') return show(env, c.t, await statsView(db));
    if (name === '/find' && arg) return show(env, c.t, await searchView(db, arg));
    if (name === '/find') { await run(db, "INSERT OR REPLACE INTO pending VALUES(?, 'find', '', ?)", me.id, Date.now()); return show(env, c.t, { text: '🔍 Напишите номер заявки, имя, телефон или email.', kb: [homeRow] }); }
    if (name === '/start' && me.joined) await show(env, c.t, { text: `🎉 Добро пожаловать в команду, <b>${esc(me.name)}</b>! Теперь новые заявки будут приходить сюда.`, kb: [] });
    return show(env, c.t, await menuView(db, me));
  }

  const p = await q1(db, 'SELECT action, arg, ts FROM pending WHERE tg_id = ?', me.id);
  if (p && Date.now() - p.ts < 10 * 60000 && p.action === 'note') {
    await run(db, 'DELETE FROM pending WHERE tg_id = ?', me.id);
    if (await q1(db, 'SELECT 1 x FROM leads WHERE id = ?', p.arg)) {
      await addEvent(db, p.arg, me.name, 'note', '📝 ' + clipText(text, 300));
      const card = await loadCard(db, p.arg, me);
      return show(env, c.t, { text: '✅ Заметка сохранена.\n\n' + card.text, kb: card.kb });
    }
  }
  await run(db, 'DELETE FROM pending WHERE tg_id = ?', me.id);
  return show(env, c.t, await searchView(db, text)); // любой другой текст — поиск
}

async function onCallback(c, data) {
  const { env, db, me, t, bg } = c;
  const [k, a, b] = data.split(':');
  if (k !== 'n' && k !== 'f') await run(db, 'DELETE FROM pending WHERE tg_id = ?', me.id);
  const card = async (id, toast) => { const v = await loadCard(db, id, me); if (!v) { await show(env, t, { text: 'Заявка не найдена: возможно, её удалили.', kb: [homeRow] }); return toast; } await show(env, t, v); return toast; };
  const touched = (id) => bg(refreshNotifs(env, id));

  switch (k) {
    case 'm': await show(env, t, await menuView(db, me)); return;
    case 'ls': await show(env, t, await listView(db, me, a, +b || 0)); return;
    case 'l': return card(a);
    case 'st': await show(env, t, await statsView(db)); return;
    case 'f':
      await run(db, "INSERT OR REPLACE INTO pending VALUES(?, 'find', '', ?)", me.id, Date.now());
      await show(env, t, { text: '🔍 Напишите номер заявки, имя, телефон или email: я найду.', kb: [homeRow] }); return;
    case 't': {
      const l = await q1(db, 'SELECT status, assignee, assignee_name FROM leads WHERE id = ?', a);
      if (!l) return card(a);
      if (l.assignee && l.assignee !== me.id && l.status !== 'new') return card(a, `Уже взял(а): ${l.assignee_name}`);
      const now = Date.now();
      await run(db, "UPDATE leads SET status = 'work', assignee = ?, assignee_name = ?, updated = ? WHERE id = ?", me.id, me.name, now, a);
      await addEvent(db, a, me.name, 'assign', '✋ Взял(а) в работу', now);
      touched(a); return card(a, 'Заявка ваша 🔥');
    }
    case 's':
      if (!(await setStatus(db, me, a, b))) return card(a);
      touched(a); return card(a, `${STATUSES[b].icon} ${STATUSES[b].label}`);
    case 'n':
      await run(db, "INSERT OR REPLACE INTO pending VALUES(?, 'note', ?, ?)", me.id, a, Date.now());
      await show(env, t, { text: `📝 <b>Заметка к ${esc(a)}</b>\n\nНапишите текст одним сообщением: например, «созвонились, ждёт КП до пятницы».`, kb: [[btn('Отмена', `l:${a}`)]] }); return;
    case 'as': {
      const st = await qa(db, 'SELECT tg_id, name FROM staff WHERE active = 1 ORDER BY name');
      await show(env, t, { text: `👤 <b>Кому передать ${esc(a)}?</b>`, kb: [...st.map((s) => [btn(s.name, `ap:${a}:${s.tg_id}`)]), [btn('‹ Назад', `l:${a}`)]] }); return;
    }
    case 'ap': {
      const s = await q1(db, 'SELECT tg_id, name FROM staff WHERE tg_id = ? AND active = 1', +b);
      if (!s) return card(a, 'Сотрудник не найден');
      const now = Date.now(), l = await q1(db, 'SELECT status FROM leads WHERE id = ?', a);
      if (!l) return card(a);
      await run(db, 'UPDATE leads SET assignee = ?, assignee_name = ?, status = ?, updated = ? WHERE id = ?', s.tg_id, s.name, l.status === 'new' ? 'work' : l.status, now, a);
      await addEvent(db, a, me.name, 'assign', `👤 Назначен(а): ${s.name}`, now);
      if (s.tg_id !== me.id) bg(tg(env, 'sendMessage', { chat_id: s.tg_id, ...HTML, text: `👤 <b>${esc(me.name)}</b> передал(а) вам заявку ${esc(a)}`, reply_markup: { inline_keyboard: [[btn('📂 Открыть', `l:${a}`)]] } }));
      touched(a); return card(a, 'Передано');
    }
    case 'd':
      if (me.role !== 'admin') return 'Только администратор';
      await show(env, t, { text: `🗑 <b>Удалить заявку ${esc(a)}?</b>\n\nОна исчезнет из бота навсегда (копия на Яндекс Диске останется).`, kb: [[btn('Да, удалить', `dd:${a}`), btn('Отмена', `l:${a}`)]] }); return;
    case 'dd':
      if (me.role !== 'admin') return 'Только администратор';
      await run(db, 'DELETE FROM events WHERE lead_id = ?', a); await run(db, 'DELETE FROM notifs WHERE lead_id = ?', a); await run(db, 'DELETE FROM leads WHERE id = ?', a);
      await show(env, t, await menuView(db, me)); return 'Удалено';
    case 'tm':
      if (me.role !== 'admin') return 'Только администратор';
      await show(env, t, await teamView(db)); return;
    case 'tx': {
      if (me.role !== 'admin') return 'Только администратор';
      await run(db, "UPDATE staff SET active = 1 - active WHERE tg_id = ? AND role != 'admin'", +a);
      await show(env, t, await teamView(db)); return 'Готово';
    }
    case 'inv': {
      if (me.role !== 'admin') return 'Только администратор';
      const code = rnd(12);
      await run(db, "INSERT INTO invites(code, role, expires, created_by) VALUES(?, 'manager', ?, ?)", code, Date.now() + 48 * 3600000, me.id);
      const u = await botUsername(env);
      await show(env, t, await teamView(db, u
        ? `🔗 Ссылка-приглашение (действует 48 часов, одно использование):\n${esc(`https://t.me/${u}?start=inv_${code}`)}\n\nОтправьте её сотруднику: после нажатия «Старт» он станет менеджером.`
        : 'Не удалось получить имя бота. Проверьте TG_BOT_TOKEN.')); return;
    }
    case 'ex': {
      if (me.role !== 'admin') return 'Только администратор';
      const rows = await qa(db, 'SELECT * FROM leads ORDER BY created DESC');
      const head = ['Получено', '№ заявки', 'Статус', 'Ответственный', 'Тип', 'Имя', 'Телефон', 'Email', 'Промокод', 'Комментарий', 'Объём, м³', 'Сумма, ₽', 'Состав заказа'];
      const csv = '\uFEFF' + [csvLine(head), ...rows.map((l) => csvLine([fmtTime(l.created), l.id, STATUSES[l.status].label, l.assignee_name, l.type, l.name, l.phone, l.email, l.promo, l.comment, l.volume, l.sum, l.text]))].join('\r\n') + '\r\n';
      const fd = new FormData();
      fd.append('chat_id', String(t.chat));
      fd.append('caption', `📥 Заявки: ${rows.length} шт. Файл содержит персональные данные, не пересылайте его посторонним.`);
      fd.append('document', new Blob([csv], { type: 'text/csv' }), `zayavki_${dayKey(Date.now())}.csv`);
      await tg(env, 'sendDocument', fd, true);
      return 'Файл отправлен';
    }
    default: return;
  }
}

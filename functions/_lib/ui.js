// Внешний вид бота: карточка заявки, клавиатуры, уведомления о новых заявках.
import { STATUSES, ORDER, esc, clipText, fmtNum, fmtTime, span, qa, q1, run, tg, adminIds } from './core.js';

export const btn = (text, data) => ({ text, callback_data: data });
export const urlBtn = (text, url) => ({ text, url });
export const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

export function waLink(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  return d.length >= 11 ? `https://wa.me/${d}` : null;
}

export function cardText(l, events = [], now = Date.now()) {
  const st = STATUSES[l.status] || STATUSES.new;
  const L = [];
  L.push(`${st.icon} <b>Заявка ${esc(l.id)}</b>  ·  ${esc(st.label)}`);
  L.push(`<i>${esc(l.type || 'Заявка с сайта')}</i>`, '');
  L.push(`👤 <b>${esc(l.name)}</b>`);
  L.push(`📞 ${esc(l.phone)}`);
  if (l.email) L.push(`✉️ ${esc(l.email)}`);
  if (l.promo) L.push(`🏷 Промокод: ${esc(l.promo)}`);
  if (l.volume || l.sum) {
    const parts = [];
    if (l.volume) parts.push(`📦 ${l.volume} м³`);
    if (l.sum) parts.push(`💰 ${fmtNum(l.sum)} ₽`);
    L.push(parts.join('  ·  '));
  }
  if (l.comment) L.push(`💬 ${esc(clipText(l.comment, 800))}`);
  if (l.text) L.push(`<blockquote expandable>${esc(clipText(l.text, 1200))}</blockquote>`);
  L.push('', `👷 ${l.assignee_name ? esc(l.assignee_name) : 'не назначен'}   🕒 ${fmtTime(l.created)} · ${span(now - l.created)} назад`);
  if (events.length) {
    L.push('', '<b>История</b>');
    for (const e of events) L.push(`▫️ ${fmtTime(e.ts)} · ${esc(e.who)}: ${esc(clipText(e.text, 300))}`);
  }
  return L.join('\n');
}

export function cardKeyboard(l, me) {
  const rows = [];
  const canTake = l.status === 'new' || !l.assignee;
  if (canTake) rows.push([btn('✋ Взять в работу', `t:${l.id}`)]);
  const others = ORDER.filter((s) => s !== l.status && !(s === 'work' && canTake));
  rows.push(...chunk(others.map((s) => btn(`${STATUSES[s].icon} ${s === 'new' ? 'Вернуть в новые' : STATUSES[s].label}`, `s:${l.id}:${s}`)), 2));
  const wa = waLink(l.phone);
  rows.push([btn('📝 Заметка', `n:${l.id}`), ...(wa ? [urlBtn('💬 WhatsApp', wa)] : [])]);
  const adm = [btn('👤 Передать', `as:${l.id}`)];
  if (me && me.role === 'admin') adm.push(btn('🗑 Удалить', `d:${l.id}`));
  rows.push(adm);
  rows.push([btn(`‹ ${STATUSES[l.status].icon} ${STATUSES[l.status].short}`, `ls:${l.status}:0`), btn('🏠 Меню', 'm')]);
  return rows;
}

export async function loadCard(db, id, me) {
  const l = await q1(db, 'SELECT * FROM leads WHERE id = ?', id);
  if (!l) return null;
  const ev = (await qa(db, 'SELECT ts, who, text FROM events WHERE lead_id = ? ORDER BY id DESC LIMIT 4', id)).reverse();
  return { text: cardText(l, ev), kb: cardKeyboard(l, me), lead: l };
}

// Уведомление всем сотрудникам: карточка + кнопки «Взять» / «Открыть»
const notifKb = (l) => [l.status === 'new' ? [btn('✋ Взять в работу', `t:${l.id}`), btn('📂 Открыть', `l:${l.id}`)] : [btn('📂 Открыть', `l:${l.id}`)]];

export async function notifyNewLead(env, l) {
  if (!env.TG_BOT_TOKEN) return false;
  const ids = adminIds(env);
  if (env.DB) for (const r of await qa(env.DB, 'SELECT tg_id FROM staff WHERE active = 1')) ids.add(r.tg_id);
  let ok = false;
  await Promise.all([...ids].map(async (id) => {
    const r = await tg(env, 'sendMessage', {
      chat_id: id, text: `🔔 <b>Новая заявка!</b>\n\n${cardText(l)}`, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: notifKb(l) },
    });
    if (r.ok) {
      ok = true;
      if (env.DB) await run(env.DB, 'INSERT OR REPLACE INTO notifs(lead_id, chat_id, msg_id) VALUES(?,?,?)', l.id, id, r.result.message_id);
    }
  }));
  return ok;
}

// После смены статуса/ответственного обновляем сообщения-уведомления у всех
export async function refreshNotifs(env, leadId) {
  const l = await q1(env.DB, 'SELECT * FROM leads WHERE id = ?', leadId);
  if (!l) return;
  const ev = (await qa(env.DB, 'SELECT ts, who, text FROM events WHERE lead_id = ? ORDER BY id DESC LIMIT 2', leadId)).reverse();
  const rows = await qa(env.DB, 'SELECT chat_id, msg_id FROM notifs WHERE lead_id = ?', leadId);
  await Promise.all(rows.map((n) => tg(env, 'editMessageText', {
    chat_id: n.chat_id, message_id: n.msg_id, text: cardText(l, ev), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: notifKb(l) },
  })));
}

// منطق بوت الطلاب: تصفح المكتبة، أحدث الملفات، الأكثر تحميلًا، تنزيل الملفات
import * as q from './db.js';
import { esc, fmtSize, parseId, redact } from './util.js';

const PAGE = 8;
const T = {
  welcomeFallback: 'مرحبًا بك في المكتبة الجامعية الرقمية. اختر من القائمة للبدء.',
  chooseUni: 'اختر الجامعة:',
  chooseCollege: 'اختر الكلية:',
  chooseDept: 'اختر القسم:',
  chooseLevel: 'اختر المستوى الدراسي:',
  chooseSemester: 'اختر الفصل الدراسي:',
  chooseCourse: 'اختر المادة:',
  empty: 'لا يوجد محتوى متاح هنا حاليًا.',
  notAvailable: 'عذرًا، هذا الملف غير متاح حاليًا.',
  sendFailed: 'تعذّر إرسال الملف الآن. حاول مرة أخرى لاحقًا.',
  sent: 'تم إرسال الملف بنجاح ✅',
  error: 'حدث خطأ مؤقت. حاول مرة أخرى بعد قليل.',
  help: 'طريقة الاستخدام:\n• «تصفح المكتبة» للوصول إلى الملفات بحسب الجامعة والكلية والقسم والمادة.\n• «أحدث الملفات» لآخر ما أُضيف.\n• «الأكثر تحميلًا» لأكثر الملفات طلبًا.\nعند اختيار ملف اضغط «تنزيل الملف» ليصلك في هذه المحادثة.',
  hint: 'استخدم الأزرار أدناه للتنقل في المكتبة.',
};

// ---------- Telegram ----------
async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !data || !data.ok) {
    throw new Error(`telegram ${method} failed: ${res.status} ${data?.description ?? ''}`);
  }
  return data.result;
}

async function show(env, ctx, text, rows) {
  const payload = { chat_id: ctx.chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (ctx.messageId) {
    try {
      await tg(env, 'editMessageText', { ...payload, message_id: ctx.messageId });
      return;
    } catch (e) {
      if (/not modified/i.test(e.message)) return;
      // تعذر التعديل (رسالة قديمة مثلًا): نرسل رسالة جديدة
    }
  }
  await tg(env, 'sendMessage', payload);
}

// ---------- لوحات الأزرار ----------
const btn = (text, data) => ({ text, callback_data: data });
const HOME = [btn('🏠 القائمة الرئيسية', 'home')];

const mainMenu = () => [
  [btn('📚 تصفح المكتبة', 'u')],
  [btn('🆕 أحدث الملفات', 'new:0'), btn('🔥 الأكثر تحميلًا', 'top:0')],
  [btn('❓ المساعدة', 'help')],
];

function listRows(items, prefix, back) {
  const rows = items.map((i) => [btn(i.label ?? i.name, `${prefix}:${i.id}`)]);
  rows.push([btn('⬅️ رجوع', back), ...HOME]);
  return rows;
}

function pagedRows(items, base, page, itemPrefix, back) {
  const hasNext = items.length > PAGE;
  const shown = items.slice(0, PAGE);
  const rows = shown.map((f) => [btn(`${f.title}  (${f.extension.toUpperCase()})`, `${itemPrefix}:${f.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('◀️ السابق', `${base}:${page - 1}`));
  if (hasNext) nav.push(btn('التالي ▶️', `${base}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn('⬅️ رجوع', back), ...HOME]);
  return rows;
}

// ---------- نقطة الدخول ----------
export async function handleUpdate(env, update) {
  const msg = update.message;
  const cb = update.callback_query;
  if (!msg && !cb) return;
  const from = (msg ?? cb).from;
  const chat = msg ? msg.chat : cb.message?.chat;

  if (cb) await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!from || from.is_bot || !chat || chat.type !== 'private') return;

  const user = await q.touchUser(env.DB, from);
  if (!user || user.status === 'blocked') return;

  const ctx = { chatId: chat.id, messageId: cb?.message?.message_id ?? null, user };
  try {
    if (cb) await onCallback(env, ctx, String(cb.data ?? ''));
    else await onMessage(env, ctx, msg);
  } catch (e) {
    console.error('handler error:', redact(e.message, env));
    await tg(env, 'sendMessage', { chat_id: ctx.chatId, text: T.error }).catch(() => {});
  }
}

async function onMessage(env, ctx, msg) {
  const text = typeof msg.text === 'string' ? msg.text : '';
  ctx.messageId = null;
  if (text.startsWith('/start')) {
    const name = await q.getSetting(env.DB, 'library_name', 'UNILIB');
    const welcome = await q.getSetting(env.DB, 'welcome_message', T.welcomeFallback);
    return show(env, ctx, `<b>${esc(name)}</b>\n\n${esc(welcome)}`, mainMenu());
  }
  return show(env, ctx, T.hint, mainMenu());
}

async function onCallback(env, ctx, data) {
  const [cmd, a, b] = data.split(':');
  const id = parseId(a);
  const db = env.DB;

  switch (cmd) {
    case 'home':
      return show(env, ctx, 'القائمة الرئيسية:', mainMenu());
    case 'help':
      return show(env, ctx, T.help, [HOME]);
    case 'u': {
      const items = await q.universities(db);
      return show(env, ctx, items.length ? T.chooseUni : T.empty, listRows(items, 'c', 'home'));
    }
    case 'c': { // كليات جامعة
      if (id === null) return notFound(env, ctx);
      const items = await q.colleges(db, id);
      return show(env, ctx, items.length ? T.chooseCollege : T.empty, listRows(items, 'd', 'u'));
    }
    case 'd': { // أقسام كلية
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.college(db, id);
      const items = await q.departments(db, id);
      return show(env, ctx, items.length ? T.chooseDept : T.empty, listRows(items, 'l', p ? `c:${p.p}` : 'u'));
    }
    case 'l': { // مستويات قسم
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.department(db, id);
      const items = await q.levels(db, id);
      return show(env, ctx, items.length ? T.chooseLevel : T.empty, listRows(items, 's', p ? `d:${p.p}` : 'u'));
    }
    case 's': { // فصول مستوى
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.level(db, id);
      const items = await q.semesters(db, id);
      return show(env, ctx, items.length ? T.chooseSemester : T.empty, listRows(items, 'k', p ? `l:${p.p}` : 'u'));
    }
    case 'k': { // مواد فصل
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.semester(db, id);
      const items = (await q.courses(db, id)).map((c) => ({ id: c.id, label: `${c.name} (${c.files_count})` }));
      return show(env, ctx, items.length ? T.chooseCourse : T.empty, listRows(items, 'f', p ? `s:${p.p}` : 'u'));
    }
    case 'f': { // ملفات مادة
      if (id === null) return notFound(env, ctx);
      const page = Math.min(parseId(b) ?? 0, 1000);
      const p = await q.parentOf.course(db, id);
      const items = await q.filesOfCourse(db, id, PAGE, page * PAGE);
      return show(env, ctx, items.length ? 'اختر الملف:' : T.empty, pagedRows(items, `f:${id}`, page, 'vb', p ? `k:${p.p}` : 'u'));
    }
    case 'new': {
      const page = Math.min(id ?? 0, 1000);
      const items = await q.latestFiles(db, PAGE, page * PAGE);
      return show(env, ctx, items.length ? '🆕 أحدث الملفات:' : T.empty, pagedRows(items, 'new', page, 'vn', 'home'));
    }
    case 'top': {
      const page = Math.min(id ?? 0, 1000);
      const items = await q.topFiles(db, PAGE, page * PAGE);
      return show(env, ctx, items.length ? '🔥 الأكثر تحميلًا:' : T.empty, pagedRows(items, 'top', page, 'vt', 'home'));
    }
    case 'vb': case 'vn': case 'vt':
      return fileCard(env, ctx, id, cmd);
    case 'g':
      return download(env, ctx, id);
    default:
      return notFound(env, ctx);
  }
}

const notFound = (env, ctx) => show(env, ctx, T.notAvailable, [HOME]);

async function fileCard(env, ctx, id, source) {
  if (id === null) return notFound(env, ctx);
  const f = await q.visibleFile(env.DB, id);
  if (!f) return notFound(env, ctx);
  const back = source === 'vn' ? 'new:0' : source === 'vt' ? 'top:0' : `f:${f.course_id}:0`;
  const lines = [
    `<b>${esc(f.title)}</b>`,
    `المادة: ${esc(f.course_name)}`,
    f.doctor_name ? `الدكتور: ${esc(f.doctor_name)}` : null,
    `المستوى: ${esc(f.level_name)}`,
    `نوع المحتوى: ${esc(f.category_name)}`,
    `تاريخ الإضافة: ${esc(String(f.created_at).slice(0, 10))}`,
    `الحجم: ${fmtSize(f.size_bytes)}`,
    f.description ? `\n${esc(f.description)}` : null,
  ].filter(Boolean);
  return show(env, ctx, lines.join('\n'), [[btn('⬇️ تنزيل الملف', `g:${f.id}`)], [btn('⬅️ رجوع', back), ...HOME]]);
}

async function download(env, ctx, id) {
  if (id === null) return notFound(env, ctx);
  const f = await q.visibleFile(env.DB, id); // يتحقق أن الملف منشور وأن تصنيفاته مفعّلة
  if (!f) return tg(env, 'sendMessage', { chat_id: ctx.chatId, text: T.notAvailable });
  try {
    await tg(env, 'sendDocument', { chat_id: ctx.chatId, document: f.tg_file_id, caption: String(f.title).slice(0, 200) });
  } catch (e) {
    console.error('sendDocument failed:', redact(e.message, env), 'file', f.id);
    return tg(env, 'sendMessage', { chat_id: ctx.chatId, text: T.sendFailed });
  }
  await q.recordDownload(env.DB, f.id, ctx.user.id); // لا يُسجَّل التنزيل إلا بعد نجاح الإرسال
  await tg(env, 'sendMessage', { chat_id: ctx.chatId, text: T.sent, reply_markup: { inline_keyboard: [HOME] } });
}

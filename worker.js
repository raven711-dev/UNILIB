// UNILIB — Worker (ملف مدمج من src/). لا تعدّله يدويًا؛ يُولَّد بـ tools/bundle.py

// ===== util.js =====
// أدوات مساعدة: مقارنة آمنة، تهريب HTML، تنسيق الحجم، إخفاء الأسرار من السجلات

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} بايت`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} ك.ب`;
  return `${(b / 1024 / 1024).toFixed(1)} م.ب`;
}

function redact(text, env) {
  let t = String(text ?? '');
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'SESSION_SIGNING_KEY']) {
    if (env && env[k]) t = t.split(env[k]).join('[مخفي]');
  }
  return t;
}

function parseId(v) {
  return typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null;
}

// ===== db.js =====
// استعلامات قاعدة البيانات (كلها مُعامَلة Parameterized)

const VISIBLE_FILE_FROM = `
FROM files f
JOIN courses c ON c.id = f.course_id AND c.is_active = 1
JOIN semesters s ON s.id = c.semester_id AND s.is_active = 1
JOIN academic_levels l ON l.id = s.level_id AND l.is_active = 1
JOIN departments d ON d.id = l.department_id AND d.is_active = 1
JOIN colleges co ON co.id = d.college_id AND co.is_active = 1
JOIN universities u ON u.id = co.university_id AND u.is_active = 1
JOIN categories cat ON cat.id = f.category_id
LEFT JOIN doctors dr ON dr.id = c.doctor_id
WHERE f.status = 'published'`;

const FILE_COLS = `f.id, f.title, f.description, f.size_bytes, f.extension, f.created_at, f.tg_file_id,
  f.course_id, c.name AS course_name, l.name AS level_name, cat.name AS category_name, dr.name AS doctor_name`;

async function getSetting(db, key, fallback) {
  const r = await db.prepare('SELECT value FROM bot_settings WHERE key = ?').bind(key).first();
  return r ? r.value : fallback;
}

// يعيد false إذا كان التحديث مكررًا
async function claimUpdate(db, updateId) {
  const r = await db.prepare('INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)').bind(updateId).run();
  return (r.meta?.changes ?? 0) > 0;
}

async function touchUser(db, tgUser) {
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').slice(0, 100) || null;
  // لا يكتب إلا عند مستخدم جديد أو نشاط قديم (للتوفير في حد الكتابة اليومي)
  await db.prepare(
    `INSERT INTO users (telegram_id, display_name, username) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET display_name = excluded.display_name,
       username = excluded.username, last_active_at = datetime('now')
     WHERE users.last_active_at < datetime('now', '-5 minutes')`
  ).bind(tgUser.id, name, tgUser.username ?? null).run();
  return db.prepare('SELECT id, status FROM users WHERE telegram_id = ?').bind(tgUser.id).first();
}

const list = async (db, sql, ...p) => (await db.prepare(sql).bind(...p).all()).results ?? [];

const universities = (db) =>
  list(db, 'SELECT id, name FROM universities WHERE is_active = 1 ORDER BY sort_order, name');
const colleges = (db, id) =>
  list(db, 'SELECT id, name FROM colleges WHERE university_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
const departments = (db, id) =>
  list(db, 'SELECT id, name FROM departments WHERE college_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
const levels = (db, id) =>
  list(db, 'SELECT id, name FROM academic_levels WHERE department_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
const semesters = (db, id) =>
  list(db, 'SELECT id, name FROM semesters WHERE level_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
const courses = (db, id) =>
  list(db,
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM files f WHERE f.course_id = c.id AND f.status = 'published') AS files_count
     FROM courses c WHERE c.semester_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.name`, id);

// الآباء (لأزرار الرجوع)
const parentOf = {
  college: (db, id) => db.prepare('SELECT university_id AS p FROM colleges WHERE id = ?').bind(id).first(),
  department: (db, id) => db.prepare('SELECT college_id AS p FROM departments WHERE id = ?').bind(id).first(),
  level: (db, id) => db.prepare('SELECT department_id AS p FROM academic_levels WHERE id = ?').bind(id).first(),
  semester: (db, id) => db.prepare('SELECT level_id AS p FROM semesters WHERE id = ?').bind(id).first(),
  course: (db, id) => db.prepare('SELECT semester_id AS p FROM courses WHERE id = ?').bind(id).first(),
};

const filesOfCourse = (db, courseId, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name ${VISIBLE_FILE_FROM} AND f.course_id = ?
            ORDER BY cat.sort_order, f.created_at DESC LIMIT ? OFFSET ?`, courseId, limit + 1, offset);

const latestFiles = (db, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name ${VISIBLE_FILE_FROM}
            ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);

const topFiles = (db, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name,
              (SELECT COUNT(*) FROM downloads dl WHERE dl.file_id = f.id) AS dl_count
            ${VISIBLE_FILE_FROM} AND EXISTS (SELECT 1 FROM downloads x WHERE x.file_id = f.id)
            ORDER BY dl_count DESC, f.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);

const visibleFile = (db, id) =>
  db.prepare(`SELECT ${FILE_COLS} ${VISIBLE_FILE_FROM} AND f.id = ?`).bind(id).first();

const recordDownload = (db, fileId, userId) =>
  db.prepare('INSERT INTO downloads (file_id, user_id) VALUES (?, ?)').bind(fileId, userId).run();

const q = { getSetting, claimUpdate, touchUser, universities, colleges, departments, levels, semesters, courses, parentOf, filesOfCourse, latestFiles, topFiles, visibleFile, recordDownload };

// ===== bot.js =====
// منطق بوت الطلاب: تصفح المكتبة، أحدث الملفات، الأكثر تحميلًا، تنزيل الملفات

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
async function handleUpdate(env, update) {
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

// ===== index.js =====
// UNILIB — نقطة الدخول: يستقبل Webhook من Telegram بعد التحقق من الرمز السري

const MAX_BODY = 200_000; // بايت

async function processUpdate(env, update) {
  try {
    if (!Number.isSafeInteger(update?.update_id)) return;
    if (!(await claimUpdate(env.DB, update.update_id))) return; // تحديث مكرر
    await handleUpdate(env, update);
  } catch (e) {
    console.error('update failed:', redact(e?.message, env));
  }
}

// خطوة إعداد لمرة واحدة: تسجّل الـ Webhook لدى Telegram. تعمل فقط إذا وُجد السر SETUP_KEY،
// ويُحذف هذا السر بعد النجاح فتتعطل الخطوة تمامًا.
async function setup(url, env) {
  if (!env.SETUP_KEY) return new Response('Not found', { status: 404 });
  if (!safeEqual(url.searchParams.get('key') ?? '', env.SETUP_KEY)) return new Response('Forbidden', { status: 403 });
  const out = (obj, status = 200) =>
    Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!env.TELEGRAM_BOT_TOKEN) return out({ ok: false, error: 'TELEGRAM_BOT_TOKEN غير مضبوط' }, 400);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? '')) {
    return out({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET غير مضبوط أو غير صالح (16 حرفًا فأكثر: حروف إنجليزية وأرقام و _ و -)' }, 400);
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${url.origin}/webhook`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      max_connections: 20,
    }),
  });
  const data = await res.json().catch(() => null);
  return out({ ok: !!data?.ok, description: redact(data?.description ?? 'لا رد من Telegram', env) }, data?.ok ? 200 : 502);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, service: 'unilib' });
    }

    if (url.pathname === '/setup' && request.method === 'GET') return setup(url, env);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret ?? '', env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response('Forbidden', { status: 403 });
      }
      const len = Number(request.headers.get('content-length') ?? 0);
      if (len > MAX_BODY) return new Response('Payload too large', { status: 413 });
      let update;
      try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      ctx.waitUntil(processUpdate(env, update)); // الرد السريع على Telegram ثم المعالجة
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },
};

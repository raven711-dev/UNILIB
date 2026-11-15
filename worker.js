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

// ======================= الإدارة =======================
const getAdmin = (db, tgId) =>
  db.prepare(
    `SELECT a.id, a.display_name, a.role_id, r.code AS role, r.rank
     FROM administrators a JOIN roles r ON r.id = a.role_id
     WHERE a.telegram_id = ? AND a.status = 'active'`).bind(tgId).first();

const rolePerms = async (db, roleId) =>
  (await list(db, 'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', roleId))
    .map((r) => r.code);

const getState = (db, tgId) =>
  db.prepare(`SELECT state, data FROM admin_state WHERE telegram_id = ? AND updated_at > datetime('now', '-30 minutes')`)
    .bind(tgId).first();
const setState = (db, tgId, state, data) =>
  db.prepare(
    `INSERT INTO admin_state (telegram_id, state, data) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = datetime('now')`
  ).bind(tgId, state, JSON.stringify(data ?? {})).run();
const clearState = (db, tgId) => db.prepare('DELETE FROM admin_state WHERE telegram_id = ?').bind(tgId).run();
// يسحب الحالة ويحذفها بعملية واحدة (يمنع التنفيذ المزدوج عند تكرار الضغط)
const takeState = (db, tgId, state) =>
  db.prepare(`DELETE FROM admin_state WHERE telegram_id = ? AND state = ?
              AND updated_at > datetime('now', '-30 minutes') RETURNING data`).bind(tgId, state).first();

const audit = (db, adminId, action, entityType, entityId, details) =>
  db.prepare('INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .bind(adminId, action, entityType, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null).run();

async function addCatalog(db, type, parentId, name, doctorName) {
  const run = async (sql, ...p) => (await db.prepare(sql).bind(...p).run()).meta?.last_row_id;
  switch (type) {
    case 'u': return run('INSERT INTO universities (name) VALUES (?)', name);
    case 'c': return run('INSERT INTO colleges (university_id, name) VALUES (?, ?)', parentId, name);
    case 'd': return run('INSERT INTO departments (college_id, name) VALUES (?, ?)', parentId, name);
    case 'l': return run('INSERT INTO academic_levels (department_id, name) VALUES (?, ?)', parentId, name);
    case 's': return run('INSERT INTO semesters (level_id, name) VALUES (?, ?)', parentId, name);
    case 'k': {
      let doctorId = null;
      if (doctorName) {
        const uni = await db.prepare(
          `SELECT co.university_id AS id FROM semesters s
           JOIN academic_levels l ON l.id = s.level_id JOIN departments d ON d.id = l.department_id
           JOIN colleges co ON co.id = d.college_id WHERE s.id = ?`).bind(parentId).first();
        if (!uni) throw new Error('semester not found');
        const found = await db.prepare('SELECT id FROM doctors WHERE university_id = ? AND name = ?').bind(uni.id, doctorName).first();
        doctorId = found ? found.id : await run('INSERT INTO doctors (university_id, name) VALUES (?, ?)', uni.id, doctorName);
      }
      return run('INSERT INTO courses (semester_id, doctor_id, name) VALUES (?, ?, ?)', parentId, doctorId, name);
    }
    default: throw new Error('bad type');
  }
}

const categories = (db) => list(db, 'SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, name');
const categoryById = (db, id) => db.prepare('SELECT id, name FROM categories WHERE id = ? AND is_active = 1').bind(id).first();
const courseInfo = (db, id) => db.prepare('SELECT id, name FROM courses WHERE id = ? AND is_active = 1').bind(id).first();
const allowedType = (db, ext) =>
  db.prepare('SELECT extension, mime_type, max_size_bytes FROM allowed_file_types WHERE extension = ? AND is_allowed = 1').bind(ext).first();
const duplicateFile = (db, uniqueId) =>
  db.prepare(`SELECT id, title FROM files WHERE tg_file_unique_id = ? AND status <> 'deleted'`).bind(uniqueId).first();

async function insertFile(db, f) {
  const r = await db.prepare(
    `INSERT INTO files (public_id, course_id, category_id, title, description, search_text, extension, mime_type,
       size_bytes, tg_file_id, tg_file_unique_id, archive_chat_id, archive_message_id, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(f.public_id, f.course_id, f.category_id, f.title, f.description ?? null, f.search_text, f.extension, f.mime_type ?? null,
    f.size_bytes, f.tg_file_id, f.tg_file_unique_id, f.archive_chat_id, f.archive_message_id, f.added_by).run();
  return r.meta?.last_row_id;
}

const adminFiles = (db, limit, offset) =>
  list(db, `SELECT id, title, status, extension FROM files WHERE status <> 'deleted'
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, limit + 1, offset);
const adminFile = (db, id) =>
  db.prepare(`SELECT f.id, f.public_id, f.title, f.description, f.status, f.size_bytes, f.extension, f.created_at, c.name AS course_name
              FROM files f JOIN courses c ON c.id = f.course_id WHERE f.id = ? AND f.status <> 'deleted'`).bind(id).first();
const setFileStatus = (db, id, status, adminId) =>
  status === 'deleted'
    ? db.prepare(`UPDATE files SET status = 'deleted', deleted_at = datetime('now'), deleted_by = ?, updated_at = datetime('now')
                  WHERE id = ? AND status <> 'deleted'`).bind(adminId, id).run()
    : db.prepare(`UPDATE files SET status = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'deleted'`).bind(status, id).run();
const setFileTitle = (db, id, title) =>
  db.prepare(`UPDATE files SET title = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'deleted'`).bind(title, id).run();

const rolesBelow = (db, rank) => list(db, 'SELECT id, code, name_ar FROM roles WHERE rank < ? ORDER BY rank DESC', rank);
const roleById = (db, id) => db.prepare('SELECT id, code, name_ar, rank FROM roles WHERE id = ?').bind(id).first();
const adminByTelegram = (db, tgId) => db.prepare('SELECT id, status FROM administrators WHERE telegram_id = ?').bind(tgId).first();
const insertAdmin = (db, tgId, roleId, createdBy) =>
  db.prepare('INSERT INTO administrators (telegram_id, display_name, role_id, created_by) VALUES (?, ?, ?, ?)')
    .bind(tgId, `مشرف ${tgId}`, roleId, createdBy).run();
const listAdmins = (db) =>
  list(db, `SELECT a.telegram_id, a.status, r.name_ar FROM administrators a JOIN roles r ON r.id = a.role_id ORDER BY r.rank DESC, a.id`);

async function libraryStats(db) {
  const one = async (sql) => Object.values((await db.prepare(sql).first()) ?? { n: 0 })[0];
  return {
    users: await one('SELECT COUNT(*) FROM users'),
    newToday: await one(`SELECT COUNT(*) FROM users WHERE first_seen_at >= date('now')`),
    files: await one(`SELECT COUNT(*) FROM files WHERE status = 'published'`),
    downloads: await one('SELECT COUNT(*) FROM downloads'),
    downloadsToday: await one(`SELECT COUNT(*) FROM downloads WHERE created_at >= date('now')`),
  };
}

const setSetting = (db, key, value, adminId) =>
  db.prepare(`INSERT INTO bot_settings (key, value, updated_by) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`)
    .bind(key, String(value), adminId).run();

const q = { getSetting, claimUpdate, touchUser, universities, colleges, departments, levels, semesters, courses, parentOf, filesOfCourse, latestFiles, topFiles, visibleFile, recordDownload, getAdmin, rolePerms, getState, setState, clearState, takeState, audit, addCatalog, categories, categoryById, courseInfo, allowedType, duplicateFile, insertFile, adminFiles, adminFile, setFileStatus, setFileTitle, rolesBelow, roleById, adminByTelegram, insertAdmin, listAdmins, libraryStats, setSetting };

// ===== tg.js =====
// أدوات Telegram المشتركة: استدعاء API، عرض/تعديل الرسائل، الأزرار

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

const btn = (text, data) => ({ text, callback_data: data });
const HOME = [btn('🏠 القائمة الرئيسية', 'home')];

// ===== admin.js =====
// لوحة الإدارة داخل البوت: التصنيفات، رفع الملفات والأرشفة، إدارة الملفات، المشرفون، الإحصائيات
// كل عملية تتحقق من الصلاحية في الخادم؛ لا يُعتمد على إخفاء الأزرار.

const AP = 8; // عدد الملفات في الصفحة
const NEXT = { u: 'c', c: 'd', d: 'l', l: 's', s: 'k' };
const TITLES = { u: 'الجامعات', c: 'الكليات', d: 'الأقسام', l: 'المستويات', s: 'الفصول', k: 'المواد' };
const SINGULAR = { u: 'جامعة', c: 'كلية', d: 'قسم', l: 'مستوى', s: 'فصل', k: 'مادة' };
const ADMIN_HOME = [btn('⚙️ لوحة الإدارة', 'a:menu'), btn('🏠 الرئيسية', 'home')];
const CANCEL_ROW = [btn('✖️ إلغاء', 'a:cancel')];
const FORBIDDEN = 'ليست لديك صلاحية لهذه العملية.';

async function loadAdmin(db, tgId) {
  const a = await q.getAdmin(db, tgId);
  if (!a) return null;
  return { ...a, perms: new Set(await q.rolePerms(db, a.role_id)) };
}

const can = (ctx, perm) => !!ctx.admin && ctx.admin.perms.has(perm);
const denied = (env, ctx) => show(env, ctx, FORBIDDEN, [ADMIN_HOME]);
const clean = (s, max = 100) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 1 && t.length <= max ? t : null;
};
const isUnique = (e) => /UNIQUE|constraint/i.test(String(e?.message));

// ---------- القائمة ----------
function menuRows(ctx) {
  const rows = [];
  if (can(ctx, 'files.create')) rows.push([btn('➕ إضافة ملف', 'a:up')]);
  if (can(ctx, 'catalog.manage')) rows.push([btn('🗂 إدارة الجامعات والمواد', 'a:n:u:0')]);
  if (can(ctx, 'files.view')) rows.push([btn('📄 إدارة الملفات', 'a:fl:0')]);
  if (can(ctx, 'stats.view')) rows.push([btn('📊 الإحصائيات', 'a:st')]);
  if (can(ctx, 'admins.manage')) rows.push([btn('👥 المشرفون', 'a:al'), btn('➕ إضافة مشرف', 'a:ad')]);
  rows.push([btn('🏠 القائمة الرئيسية', 'home')]);
  return rows;
}
const showMenu = (env, ctx) => show(env, ctx, `<b>لوحة الإدارة</b>\nالدور: ${esc(ctx.admin.role)}`, menuRows(ctx));

// ---------- تصفح التصنيفات (n: إدارة، p: اختيار مادة للرفع) ----------
async function children(db, type, parent) {
  switch (type) {
    case 'u': return q.universities(db);
    case 'c': return q.colleges(db, parent);
    case 'd': return q.departments(db, parent);
    case 'l': return q.levels(db, parent);
    case 's': return q.semesters(db, parent);
    case 'k': return (await q.courses(db, parent)).map((c) => ({ id: c.id, name: `${c.name} (${c.files_count})` }));
    default: return [];
  }
}

async function backFor(db, mode, type, parent) {
  const to = (t, p) => `a:${mode}:${t}:${p}`;
  if (type === 'u') return mode === 'n' ? 'a:menu' : 'a:menu';
  if (type === 'c') return to('u', 0);
  const probe = { d: ['college', 'c'], l: ['department', 'd'], s: ['level', 'l'], k: ['semester', 's'] }[type];
  const r = await q.parentOf[probe[0]](db, parent);
  return r ? to(probe[1], r.p) : to('u', 0);
}

async function navigate(env, ctx, mode, type, parent) {
  const perm = mode === 'n' ? 'catalog.manage' : 'files.create';
  if (!can(ctx, perm)) return denied(env, ctx);
  if (!TITLES[type]) return show(env, ctx, FORBIDDEN, [ADMIN_HOME]);
  const items = await children(env.DB, type, parent);
  const rows = items.map((i) => [btn(i.name, type === 'k' ? (mode === 'p' ? `a:uc:${i.id}` : 'a:noop') : `a:${mode}:${NEXT[type]}:${i.id}`)]);
  if (mode === 'n') rows.push([btn(`➕ إضافة ${SINGULAR[type]}`, `a:+:${type}:${parent}`)]);
  rows.push([btn('⬅️ رجوع', await backFor(env.DB, mode, type, parent)), btn('⚙️ الإدارة', 'a:menu')]);
  const head = mode === 'p' ? 'اختر المادة التي سيُرفع إليها الملف.\n' : '';
  return show(env, ctx, `${head}${items.length ? `${TITLES[type]}:` : `لا توجد ${TITLES[type]} بعد.`}`, rows);
}

// ---------- الإدخال النصي والملفات ----------
async function adminMessage(env, ctx, msg) {
  const db = env.DB;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  ctx.messageId = null;

  if (text === '/cancel') { await q.clearState(db, ctx.tgId); await show(env, ctx, 'تم الإلغاء.', [ADMIN_HOME]); return true; }
  if (text.startsWith('/admin')) { await q.clearState(db, ctx.tgId); await showMenu(env, ctx); return true; }

  const st = await q.getState(db, ctx.tgId);
  if (!st) {
    // إعادة توجيه منشور من قناة الأرشيف إلى البوت تضبط القناة (للمالك فقط)
    const fo = msg.forward_origin;
    const fchat = fo?.type === 'channel' ? fo.chat : msg.forward_from_chat?.type === 'channel' ? msg.forward_from_chat : null;
    if (!fchat) return false;
    if (!can(ctx, 'settings.security')) { await denied(env, ctx); return true; }
    await q.setSetting(db, 'archive_chat_id', fchat.id, ctx.admin.id);
    await q.audit(db, ctx.admin.id, 'settings.archive_channel', 'setting', 'archive_chat_id', { chat: fchat.id });
    await show(env, ctx, `تم ضبط قناة الأرشيف: <b>${esc(fchat.title ?? '')}</b> ✅\nتأكد أن البوت مشرف فيها بصلاحية نشر الرسائل.`, [ADMIN_HOME]);
    return true;
  }
  const d = JSON.parse(st.data || '{}');

  switch (st.state) {
    case 'add_name': {
      if (!can(ctx, 'catalog.manage')) return (await denied(env, ctx), true);
      const name = clean(text);
      if (!name) { await show(env, ctx, 'الاسم غير صالح. اكتب اسمًا من 1 إلى 100 حرف.', [CANCEL_ROW]); return true; }
      if (d.type === 'k') {
        await q.setState(db, ctx.tgId, 'add_doctor', { ...d, name });
        await show(env, ctx, 'اكتب اسم الدكتور، أو أرسل - لتخطي هذه الخطوة.', [CANCEL_ROW]);
        return true;
      }
      return finishAdd(env, ctx, d, name, null);
    }
    case 'add_doctor': {
      if (!can(ctx, 'catalog.manage')) return (await denied(env, ctx), true);
      const doctor = text === '-' ? null : clean(text);
      if (text !== '-' && !doctor) { await show(env, ctx, 'الاسم غير صالح. أعد الكتابة أو أرسل -', [CANCEL_ROW]); return true; }
      return finishAdd(env, ctx, d, d.name, doctor);
    }
    case 'up_file': {
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      return receiveFile(env, ctx, msg, d);
    }
    case 'up_title': {
      const title = clean(text, 200);
      if (!title) { await show(env, ctx, 'العنوان غير صالح (حتى 200 حرف).', [CANCEL_ROW]); return true; }
      await q.setState(db, ctx.tgId, 'up_desc', { ...d, title });
      await show(env, ctx, 'اكتب وصفًا مختصرًا للملف، أو أرسل - لتخطيه.', [CANCEL_ROW]);
      return true;
    }
    case 'up_desc': {
      const description = text === '-' ? null : clean(text, 1000);
      if (text !== '-' && !description) { await show(env, ctx, 'الوصف غير صالح. أعد الكتابة أو أرسل -', [CANCEL_ROW]); return true; }
      const nd = { ...d, description };
      await q.setState(db, ctx.tgId, 'up_confirm', nd);
      const course = await q.courseInfo(db, nd.course_id);
      const cat = await q.categoryById(db, nd.category_id);
      await show(env, ctx,
        `<b>مراجعة قبل النشر</b>\nالعنوان: ${esc(nd.title)}\nالمادة: ${esc(course?.name)}\nنوع المحتوى: ${esc(cat?.name)}\n` +
        `النوع: ${esc(nd.extension.toUpperCase())}  |  الحجم: ${fmtSize(nd.size_bytes)}\n${nd.description ? `الوصف: ${esc(nd.description)}` : 'بدون وصف'}`,
        [[btn('✅ تأكيد النشر', 'a:uok')], CANCEL_ROW]);
      return true;
    }
    case 'edit_title': {
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const title = clean(text, 200);
      if (!title) { await show(env, ctx, 'العنوان غير صالح (حتى 200 حرف).', [CANCEL_ROW]); return true; }
      await q.clearState(db, ctx.tgId);
      await q.setFileTitle(db, d.id, title);
      await q.audit(db, ctx.admin.id, 'file.edit', 'file', d.id, { title });
      await show(env, ctx, 'تم تعديل العنوان ✅', [[btn('📄 الملف', `a:fv:${d.id}`)], ADMIN_HOME]);
      return true;
    }
    case 'adm_id': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      if (!/^\d{5,15}$/.test(text)) { await show(env, ctx, 'أرسل رقم حساب Telegram (أرقام فقط).', [CANCEL_ROW]); return true; }
      const tgId = Number(text);
      if (await q.adminByTelegram(db, tgId)) { await show(env, ctx, 'هذا الحساب مسجَّل كمشرف بالفعل.', [CANCEL_ROW]); return true; }
      const roles = await q.rolesBelow(db, ctx.admin.rank);
      if (!roles.length) { await q.clearState(db, ctx.tgId); await denied(env, ctx); return true; }
      await q.setState(db, ctx.tgId, 'adm_role', { tg: tgId });
      await show(env, ctx, 'اختر دور المشرف الجديد:', [...roles.map((r) => [btn(r.name_ar, `a:ar:${r.id}`)]), CANCEL_ROW]);
      return true;
    }
    default:
      return false;
  }
}

async function finishAdd(env, ctx, d, name, doctor) {
  await q.clearState(env.DB, ctx.tgId);
  try {
    const id = await q.addCatalog(env.DB, d.type, d.parent, name, doctor);
    await q.audit(env.DB, ctx.admin.id, `catalog.add.${d.type}`, 'catalog', id, { name, parent: d.parent });
    await show(env, ctx, `تمت إضافة ${SINGULAR[d.type]}: <b>${esc(name)}</b> ✅`, [[btn('➕ إضافة أخرى', `a:+:${d.type}:${d.parent}`)], [btn('⬅️ القائمة', `a:n:${d.type}:${d.parent}`)], ADMIN_HOME]);
  } catch (e) {
    const msg = isUnique(e) ? 'هذا الاسم موجود مسبقًا في نفس المكان.' : 'تعذّرت الإضافة. تأكد أن التصنيف الأعلى ما زال موجودًا.';
    if (!isUnique(e)) console.error('addCatalog failed:', redact(e.message, env));
    await show(env, ctx, msg, [ADMIN_HOME]);
  }
  return true;
}

async function receiveFile(env, ctx, msg, d) {
  const db = env.DB;
  const doc = msg.document;
  if (!doc) { await show(env, ctx, 'أرسل الملف كـ «مستند» (Document)، وليس كصورة أو نص.', [CANCEL_ROW]); return true; }
  const ext = (/\.([A-Za-z0-9]{1,10})$/.exec(doc.file_name ?? '') ?? [])[1]?.toLowerCase();
  const type = ext ? await q.allowedType(db, ext) : null;
  if (!type) { await show(env, ctx, 'نوع الملف غير مسموح به أو غير معروف. المسموح يُحدَّد من إعدادات المكتبة.', [CANCEL_ROW]); return true; }
  const maxSize = Number(await q.getSetting(db, 'max_file_size_bytes', '20971520'));
  const limit = type.max_size_bytes ? Math.min(maxSize, type.max_size_bytes) : maxSize;
  if (!Number.isFinite(doc.file_size) || doc.file_size > limit) {
    await show(env, ctx, `حجم الملف يتجاوز الحد المسموح (${fmtSize(limit)}).`, [CANCEL_ROW]);
    return true;
  }
  const dup = await q.duplicateFile(db, doc.file_unique_id);
  if (dup) { await show(env, ctx, `هذا الملف موجود مسبقًا في المكتبة باسم: <b>${esc(dup.title)}</b>`, [CANCEL_ROW]); return true; }
  const base = String(doc.file_name).replace(/\.[^.]+$/, '');
  await q.setState(db, ctx.tgId, 'up_title', {
    ...d, extension: ext, mime_type: doc.mime_type ?? type.mime_type ?? null, size_bytes: doc.file_size,
    tg_file_id: doc.file_id, tg_file_unique_id: doc.file_unique_id, file_name: base.slice(0, 200),
  });
  await show(env, ctx, 'اكتب عنوان الملف كما سيظهر للطلاب.', [CANCEL_ROW]);
  return true;
}

// ---------- الأزرار ----------
async function adminCallback(env, ctx, data) {
  const db = env.DB;
  if (!ctx.admin) return false; // الطلاب: تجاهل كامل
  const [, cmd, a, b] = data.split(':');

  switch (cmd) {
    case 'menu': await q.clearState(db, ctx.tgId); return (await showMenu(env, ctx), true);
    case 'cancel': await q.clearState(db, ctx.tgId); return (await show(env, ctx, 'تم الإلغاء.', [ADMIN_HOME]), true);
    case 'noop': return true;
    case 'n': case 'p': {
      const parent = parseId(b);
      if (!TITLES[a] || parent === null) return (await show(env, ctx, FORBIDDEN, [ADMIN_HOME]), true);
      return (await navigate(env, ctx, cmd, a, parent), true);
    }
    case '+': {
      if (!can(ctx, 'catalog.manage')) return (await denied(env, ctx), true);
      const parent = parseId(b);
      if (!TITLES[a] || parent === null) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'add_name', { type: a, parent });
      return (await show(env, ctx, `اكتب اسم ${SINGULAR[a]} الجديد (حتى 100 حرف):`, [CANCEL_ROW]), true);
    }
    case 'up': return (await navigate(env, ctx, 'p', 'u', 0), true);
    case 'uc': { // تم اختيار المادة
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      const course = parseId(a) === null ? null : await q.courseInfo(db, parseId(a));
      if (!course) return (await show(env, ctx, 'المادة غير موجودة.', [ADMIN_HOME]), true);
      const cats = await q.categories(db);
      return (await show(env, ctx, `المادة: <b>${esc(course.name)}</b>\nاختر نوع المحتوى:`,
        [...cats.map((c) => [btn(c.name, `a:ut:${course.id}:${c.id}`)]), CANCEL_ROW]), true);
    }
    case 'ut': { // تم اختيار نوع المحتوى
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      const course = parseId(a) === null ? null : await q.courseInfo(db, parseId(a));
      const cat = parseId(b) === null ? null : await q.categoryById(db, parseId(b));
      if (!course || !cat) return (await show(env, ctx, 'اختيار غير صالح.', [ADMIN_HOME]), true);
      await q.setState(db, ctx.tgId, 'up_file', { course_id: course.id, category_id: cat.id });
      return (await show(env, ctx, 'أرسل الملف الآن كمستند (Document).', [CANCEL_ROW]), true);
    }
    case 'ucancel': await q.clearState(db, ctx.tgId); return (await show(env, ctx, 'تم إلغاء الرفع.', [ADMIN_HOME]), true);
    case 'uok': return (await confirmUpload(env, ctx), true);
    case 'fl': { // قائمة الملفات
      if (!can(ctx, 'files.view')) return (await denied(env, ctx), true);
      const page = Math.min(parseId(a) ?? 0, 1000);
      const items = await q.adminFiles(db, AP, page * AP);
      const icon = { published: '🟢', hidden: '🟡' };
      const rows = items.slice(0, AP).map((f) => [btn(`${icon[f.status] ?? '⚪'} ${f.title} (${f.extension.toUpperCase()})`, `a:fv:${f.id}`)]);
      const nav = [];
      if (page > 0) nav.push(btn('◀️ السابق', `a:fl:${page - 1}`));
      if (items.length > AP) nav.push(btn('التالي ▶️', `a:fl:${page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push(ADMIN_HOME);
      return (await show(env, ctx, items.length ? 'الملفات (🟢 منشور، 🟡 مخفي):' : 'لا توجد ملفات بعد.', rows), true);
    }
    case 'fv': return (await fileAdminCard(env, ctx, parseId(a)), true);
    case 'fh': case 'fp': { // إخفاء / نشر
      if (!can(ctx, 'files.hide')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await show(env, ctx, 'الملف غير موجود.', [ADMIN_HOME]), true);
      const status = cmd === 'fh' ? 'hidden' : 'published';
      await q.setFileStatus(db, id, status, ctx.admin.id);
      await q.audit(db, ctx.admin.id, status === 'hidden' ? 'file.hide' : 'file.publish', 'file', id, null);
      return (await fileAdminCard(env, ctx, id), true);
    }
    case 'fd': { // طلب تأكيد الحذف
      if (!can(ctx, 'files.delete')) return (await denied(env, ctx), true);
      const f = parseId(a) === null ? null : await q.adminFile(db, parseId(a));
      if (!f) return (await show(env, ctx, 'الملف غير موجود.', [ADMIN_HOME]), true);
      return (await show(env, ctx, `هل تريد حذف الملف <b>${esc(f.title)}</b>؟\nهذا حذف منطقي: تبقى سجلاته، ولا تُحذف نسخة الأرشيف.`,
        [[btn('🗑 نعم، احذف', `a:fy:${f.id}`)], [btn('إلغاء', `a:fv:${f.id}`)]]), true);
    }
    case 'fy': { // تنفيذ الحذف
      if (!can(ctx, 'files.delete')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await show(env, ctx, 'الملف غير موجود.', [ADMIN_HOME]), true);
      await q.setFileStatus(db, id, 'deleted', ctx.admin.id);
      await q.audit(db, ctx.admin.id, 'file.delete', 'file', id, null);
      return (await show(env, ctx, 'تم حذف الملف ✅', [[btn('📄 الملفات', 'a:fl:0')], ADMIN_HOME]), true);
    }
    case 'fe': { // تعديل العنوان
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await show(env, ctx, 'الملف غير موجود.', [ADMIN_HOME]), true);
      await q.setState(db, ctx.tgId, 'edit_title', { id });
      return (await show(env, ctx, 'اكتب العنوان الجديد للملف:', [CANCEL_ROW]), true);
    }
    case 'st': {
      if (!can(ctx, 'stats.view')) return (await denied(env, ctx), true);
      const s = await q.libraryStats(db);
      return (await show(env, ctx,
        `<b>الإحصائيات</b>\nالطلاب: ${s.users} (جدد اليوم: ${s.newToday})\nالملفات المنشورة: ${s.files}\nالتنزيلات: ${s.downloads} (اليوم: ${s.downloadsToday})`, [ADMIN_HOME]), true);
    }
    case 'al': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const list = await q.listAdmins(db);
      return (await show(env, ctx, `<b>المشرفون</b>\n${list.map((x) => `• ${x.telegram_id} — ${esc(x.name_ar)}${x.status === 'active' ? '' : ' (موقوف)'}`).join('\n')}`, [ADMIN_HOME]), true);
    }
    case 'ad': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'adm_id', {});
      return (await show(env, ctx, 'أرسل رقم حساب Telegram للمشرف الجديد (يعرفه بإرسال Start إلى @userinfobot).', [CANCEL_ROW]), true);
    }
    case 'ar': { // اختيار دور المشرف الجديد
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const st = await q.takeState(db, ctx.tgId, 'adm_role');
      if (!st) return (await show(env, ctx, 'انتهت العملية. ابدأ من جديد.', [ADMIN_HOME]), true);
      const role = parseId(a) === null ? null : await q.roleById(db, parseId(a));
      if (!role || role.rank >= ctx.admin.rank) return (await denied(env, ctx), true); // لا يمنح أعلى من صلاحيته
      const { tg: newTg } = JSON.parse(st.data);
      try {
        await q.insertAdmin(db, newTg, role.id, ctx.admin.id);
        await q.audit(db, ctx.admin.id, 'admin.add', 'administrator', newTg, { role: role.code });
        return (await show(env, ctx, `تمت إضافة المشرف ${newTg} بدور ${esc(role.name_ar)} ✅`, [ADMIN_HOME]), true);
      } catch (e) {
        return (await show(env, ctx, 'تعذّرت الإضافة (ربما سُجِّل مسبقًا).', [ADMIN_HOME]), true);
      }
    }
    default: return false;
  }
}

async function fileAdminCard(env, ctx, id) {
  if (!can(ctx, 'files.view')) return denied(env, ctx);
  const f = id === null ? null : await q.adminFile(env.DB, id);
  if (!f) return show(env, ctx, 'الملف غير موجود.', [ADMIN_HOME]);
  const rows = [];
  if (can(ctx, 'files.hide')) rows.push([f.status === 'published' ? btn('🙈 إخفاء', `a:fh:${f.id}`) : btn('👁 نشر', `a:fp:${f.id}`)]);
  if (can(ctx, 'files.edit')) rows.push([btn('✏️ تعديل العنوان', `a:fe:${f.id}`)]);
  if (can(ctx, 'files.delete')) rows.push([btn('🗑 حذف', `a:fd:${f.id}`)]);
  rows.push([btn('⬅️ الملفات', 'a:fl:0'), ...ADMIN_HOME.slice(0, 1)]);
  return show(env, ctx,
    `<b>${esc(f.title)}</b>\nالمادة: ${esc(f.course_name)}\nالحالة: ${f.status === 'published' ? 'منشور 🟢' : 'مخفي 🟡'}\nالحجم: ${fmtSize(f.size_bytes)}  |  ${esc(f.extension.toUpperCase())}\nالمعرّف: ${esc(f.public_id)}`, rows);
}

// ---------- تأكيد الرفع: الأرشفة ثم الحفظ ----------
async function confirmUpload(env, ctx) {
  const db = env.DB;
  if (!can(ctx, 'files.create')) return denied(env, ctx);
  const st = await q.takeState(db, ctx.tgId, 'up_confirm'); // تُسحب الحالة مرة واحدة: يمنع تكرار الأرشفة عند تكرار الضغط
  if (!st) return show(env, ctx, 'لا توجد عملية رفع جارية (ربما تم النشر بالفعل).', [ADMIN_HOME]);
  const d = JSON.parse(st.data);
  const archiveChat = env.ARCHIVE_CHANNEL_ID || (await q.getSetting(db, 'archive_chat_id', ''));
  const restore = () => q.setState(db, ctx.tgId, 'up_confirm', d);
  if (!archiveChat) {
    await restore();
    return show(env, ctx, 'قناة الأرشيف غير مضبوطة بعد. أضف ARCHIVE_CHANNEL_ID ثم أعد الضغط على «تأكيد».', [[btn('✅ تأكيد النشر', 'a:uok')], CANCEL_ROW]);
  }
  let archived;
  try {
    archived = await tg(env, 'sendDocument', { chat_id: archiveChat, document: d.tg_file_id, caption: String(d.title).slice(0, 200) });
  } catch (e) {
    console.error('archive failed:', redact(e.message, env));
    await restore();
    return show(env, ctx, 'تعذّر الحفظ في قناة الأرشيف. تأكد أن البوت مشرف في القناة ثم أعد المحاولة.', [[btn('🔁 إعادة المحاولة', 'a:uok')], CANCEL_ROW]);
  }
  const course = await q.courseInfo(db, d.course_id);
  try {
    const newId = await q.insertFile(db, {
      public_id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      course_id: d.course_id, category_id: d.category_id, title: d.title, description: d.description,
      search_text: `${d.title} ${d.description ?? ''} ${course?.name ?? ''}`.toLowerCase(),
      extension: d.extension, mime_type: d.mime_type, size_bytes: d.size_bytes,
      tg_file_id: archived.document?.file_id ?? d.tg_file_id,
      tg_file_unique_id: archived.document?.file_unique_id ?? d.tg_file_unique_id,
      archive_chat_id: Number(archiveChat), archive_message_id: archived.message_id, added_by: ctx.admin.id,
    });
    await q.audit(db, ctx.admin.id, 'file.create', 'file', newId, { title: d.title, course_id: d.course_id });
    return show(env, ctx, `تم نشر الملف <b>${esc(d.title)}</b> ✅`, [[btn('➕ ملف آخر', 'a:up')], ADMIN_HOME]);
  } catch (e) {
    console.error('insertFile failed:', redact(e.message, env));
    return show(env, ctx, isUnique(e) ? 'هذا الملف موجود مسبقًا في المكتبة.' : 'تعذّر حفظ بيانات الملف. تواصل مع المطوّر.', [ADMIN_HOME]);
  }
}

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

// ---------- لوحات الأزرار ----------
const mainMenu = (isAdmin = false) => [
  [btn('📚 تصفح المكتبة', 'u')],
  [btn('🆕 أحدث الملفات', 'new:0'), btn('🔥 الأكثر تحميلًا', 'top:0')],
  [btn('❓ المساعدة', 'help')],
  ...(isAdmin ? [[btn('⚙️ لوحة الإدارة', 'a:menu')]] : []),
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

  const ctx = { chatId: chat.id, tgId: from.id, messageId: cb?.message?.message_id ?? null, user, admin: await loadAdmin(env.DB, from.id) };
  try {
    if (cb) {
      const data = String(cb.data ?? '');
      if (data.startsWith('a:')) { if (!(await adminCallback(env, ctx, data))) await notFound(env, ctx); }
      else await onCallback(env, ctx, data);
    } else if (!(ctx.admin && (await adminMessage(env, ctx, msg)))) await onMessage(env, ctx, msg);
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
    return show(env, ctx, `<b>${esc(name)}</b>\n\n${esc(welcome)}`, mainMenu(!!ctx.admin));
  }
  return show(env, ctx, T.hint, mainMenu(!!ctx.admin));
}

async function onCallback(env, ctx, data) {
  const [cmd, a, b] = data.split(':');
  const id = parseId(a);
  const db = env.DB;

  switch (cmd) {
    case 'home':
      return show(env, ctx, 'القائمة الرئيسية:', mainMenu(!!ctx.admin));
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
      return Response.json({ ok: true, service: 'unilib', version: '0.3.0' });
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

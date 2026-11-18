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

// أيقونة نوع المحتوى بحسب اسمه (للتسهيل على الطالب)
function catIcon(name) {
  const n = String(name ?? '');
  if (/صور/.test(n)) return '🖼';
  if (/تسجيل|صوت/.test(n)) return '🎧';
  if (/كورس/.test(n)) return '🎓';
  if (/ملزم|شبتر|شباتر/.test(n)) return '📒';
  if (/مرجع|مراجع/.test(n)) return '📚';
  if (/اختبار|امتحان/.test(n)) return '📝';
  if (/تمار|واجب/.test(n)) return '✏️';
  if (/ملخص/.test(n)) return '🗒';
  if (/محاضر/.test(n)) return '📖';
  return '📁';
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
JOIN categories cat ON cat.id = f.category_id AND cat.is_active = 1
LEFT JOIN doctors dr ON dr.id = c.doctor_id
WHERE f.status = 'published'`;

const FILE_COLS = `f.id, f.category_id, f.media_kind, f.title, f.description, f.size_bytes, f.extension, f.created_at, f.tg_file_id,
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

const courseCategories = (db, courseId) =>
  list(db, `SELECT cat.id, cat.name, COUNT(*) AS n ${VISIBLE_FILE_FROM} AND f.course_id = ?
            GROUP BY cat.id, cat.name ORDER BY cat.sort_order, cat.name`, courseId);

const filesOfCourse = (db, courseId, categoryId, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name ${VISIBLE_FILE_FROM} AND f.course_id = ? AND f.category_id = ?
            ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`, courseId, categoryId, limit + 1, offset);

// مسار التصنيف للعرض (جامعة › كلية › ...)
const CRUMB_SQL = {
  u: 'SELECT u.name n1 FROM universities u WHERE u.id = ?',
  c: 'SELECT u.name n1, c.name n2 FROM colleges c JOIN universities u ON u.id = c.university_id WHERE c.id = ?',
  d: `SELECT u.name n1, c.name n2, d.name n3 FROM departments d JOIN colleges c ON c.id = d.college_id
      JOIN universities u ON u.id = c.university_id WHERE d.id = ?`,
  l: `SELECT u.name n1, c.name n2, d.name n3, l.name n4 FROM academic_levels l JOIN departments d ON d.id = l.department_id
      JOIN colleges c ON c.id = d.college_id JOIN universities u ON u.id = c.university_id WHERE l.id = ?`,
  s: `SELECT u.name n1, c.name n2, d.name n3, l.name n4, s.name n5 FROM semesters s JOIN academic_levels l ON l.id = s.level_id
      JOIN departments d ON d.id = l.department_id JOIN colleges c ON c.id = d.college_id JOIN universities u ON u.id = c.university_id WHERE s.id = ?`,
  k: `SELECT u.name n1, c.name n2, d.name n3, l.name n4, s.name n5, k.name n6 FROM courses k JOIN semesters s ON s.id = k.semester_id
      JOIN academic_levels l ON l.id = s.level_id JOIN departments d ON d.id = l.department_id JOIN colleges c ON c.id = d.college_id
      JOIN universities u ON u.id = c.university_id WHERE k.id = ?`,
};
async function crumb(db, kind, id) {
  if (!CRUMB_SQL[kind] || id == null) return '';
  const r = await db.prepare(CRUMB_SQL[kind]).bind(id).first();
  return r ? Object.values(r).join(' › ') : '';
}

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
    case 'g': {
      const m = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories').first();
      return run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', name, m.n);
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
       size_bytes, tg_file_id, tg_file_unique_id, archive_chat_id, archive_message_id, added_by, media_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(f.public_id, f.course_id, f.category_id, f.title, f.description ?? null, f.search_text, f.extension, f.mime_type ?? null,
    f.size_bytes, f.tg_file_id, f.tg_file_unique_id, f.archive_chat_id, f.archive_message_id, f.added_by, f.media_kind ?? 'document').run();
  return r.meta?.last_row_id;
}

const adminFiles = (db, limit, offset) =>
  list(db, `SELECT id, title, status, extension FROM files WHERE status <> 'deleted'
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, limit + 1, offset);
const adminFile = (db, id) =>
  db.prepare(`SELECT f.id, f.public_id, f.title, f.description, f.status, f.size_bytes, f.extension, f.created_at, f.media_kind,
                     f.course_id, f.category_id, c.name AS course_name, cat.name AS category_name
              FROM files f JOIN courses c ON c.id = f.course_id JOIN categories cat ON cat.id = f.category_id
              WHERE f.id = ? AND f.status <> 'deleted'`).bind(id).first();
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

// ======================= تعديل/إخفاء/حذف التصنيفات =======================
const CATALOG = {
  u: { table: 'universities', parent: null, upd: true, child: ['colleges', 'university_id'] },
  c: { table: 'colleges', parent: 'university_id', upd: true, child: ['departments', 'college_id'] },
  d: { table: 'departments', parent: 'college_id', upd: true, child: ['academic_levels', 'department_id'] },
  l: { table: 'academic_levels', parent: 'department_id', upd: false, child: ['semesters', 'level_id'] },
  s: { table: 'semesters', parent: 'level_id', upd: false, child: ['courses', 'semester_id'] },
  k: { table: 'courses', parent: 'semester_id', upd: true, child: ['files', 'course_id'] },
  g: { table: 'categories', parent: null, upd: false, child: ['files', 'category_id'] },
};
const cat = (type) => { const t = CATALOG[type]; if (!t) throw new Error('bad type'); return t; };

function catalogList(db, type, parentId) {
  const t = cat(type);
  const extra = type === 'k' ? ", (SELECT COUNT(*) FROM files f WHERE f.course_id = courses.id AND f.status <> 'deleted') AS files_count" : '';
  const sql = `SELECT id, name, is_active${extra} FROM ${t.table} ${t.parent ? `WHERE ${t.parent} = ?` : ''} ORDER BY sort_order, name`;
  return t.parent ? list(db, sql, parentId) : list(db, sql);
}
function catalogItem(db, type, id) {
  const t = cat(type);
  return db.prepare(`SELECT id, name, is_active, ${t.parent ? t.parent : '0'} AS parent FROM ${t.table} WHERE id = ?`).bind(id).first();
}
function renameCatalog(db, type, id, name) {
  const t = cat(type);
  return db.prepare(`UPDATE ${t.table} SET name = ?${t.upd ? ", updated_at = datetime('now')" : ''} WHERE id = ?`).bind(name, id).run();
}
function setCatalogActive(db, type, id, active) {
  const t = cat(type);
  return db.prepare(`UPDATE ${t.table} SET is_active = ?${t.upd ? ", updated_at = datetime('now')" : ''} WHERE id = ?`).bind(active ? 1 : 0, id).run();
}
async function catalogChildCount(db, type, id) {
  const [table, col] = cat(type).child;
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(id).first();
  return r ? r.n : 0;
}
async function deleteCatalog(db, type, id) {
  const t = cat(type);
  if (type === 'u') {
    // الدكاترة الذين لا مواد لهم يُحذفون مع الجامعة
    await db.prepare('DELETE FROM doctors WHERE university_id = ? AND id NOT IN (SELECT doctor_id FROM courses WHERE doctor_id IS NOT NULL)').bind(id).run();
  }
  return db.prepare(`DELETE FROM ${t.table} WHERE id = ?`).bind(id).run();
}

// ======================= نقل/تصنيف الملفات =======================
const moveFile = (db, id, courseId) =>
  db.prepare(`UPDATE files SET course_id = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'deleted'`).bind(courseId, id).run();
const setFileCategory = (db, id, categoryId) =>
  db.prepare(`UPDATE files SET category_id = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'deleted'`).bind(categoryId, id).run();
const setFileDescription = (db, id, d) =>
  db.prepare(`UPDATE files SET description = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'deleted'`).bind(d, id).run();

// ======================= الطلاب =======================
const usersPage = (db, limit, offset) =>
  list(db, 'SELECT id, telegram_id, display_name, username, status FROM users ORDER BY last_active_at DESC, id DESC LIMIT ? OFFSET ?', limit + 1, offset);
const userById = (db, id) =>
  db.prepare(`SELECT u.id, u.telegram_id, u.display_name, u.username, u.status, u.first_seen_at, u.last_active_at,
                (SELECT COUNT(*) FROM downloads d WHERE d.user_id = u.id) AS downloads FROM users u WHERE u.id = ?`).bind(id).first();
const setUserStatus = (db, id, status) => db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, id).run();
async function userCounts(db) {
  const r = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'blocked'), 0) AS blocked FROM users`).first();
  return r ?? { total: 0, blocked: 0 };
}

// ======================= المشرفون والأدوار والصلاحيات =======================
const adminById = (db, id) =>
  db.prepare(`SELECT a.id, a.telegram_id, a.status, a.role_id, r.code AS role, r.name_ar, r.rank
              FROM administrators a JOIN roles r ON r.id = a.role_id WHERE a.id = ?`).bind(id).first();
const setAdminRole = (db, id, roleId) =>
  db.prepare(`UPDATE administrators SET role_id = ?, updated_at = datetime('now') WHERE id = ?`).bind(roleId, id).run();
const setAdminStatus = (db, id, status) =>
  db.prepare(`UPDATE administrators SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, id).run();
const adminsList = (db) =>
  list(db, `SELECT a.id, a.telegram_id, a.status, r.name_ar, r.rank FROM administrators a JOIN roles r ON r.id = a.role_id ORDER BY r.rank DESC, a.id`);
const roleByCode = (db, code) => db.prepare('SELECT id, code, name_ar, rank FROM roles WHERE code = ?').bind(code).first();
const allPerms = (db) => list(db, 'SELECT id, code, description_ar FROM permissions ORDER BY id');
const rolePermIds = async (db, roleId) =>
  new Set((await list(db, 'SELECT permission_id FROM role_permissions WHERE role_id = ?', roleId)).map((r) => r.permission_id));
const permById = (db, id) => db.prepare('SELECT id, code, description_ar FROM permissions WHERE id = ?').bind(id).first();
const grantPerm = (db, roleId, permId) => db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').bind(roleId, permId).run();
const revokePerm = (db, roleId, permId) => db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?').bind(roleId, permId).run();
// نقل الملكية: عمليتان في معاملة واحدة (إما تنجحان معًا أو تفشلان معًا)
const transferOwnership = (db, fromId, toId, ownerRoleId, adminRoleId) =>
  db.batch([
    db.prepare(`UPDATE administrators SET role_id = ?, updated_at = datetime('now') WHERE id = ?`).bind(ownerRoleId, toId),
    db.prepare(`UPDATE administrators SET role_id = ?, updated_at = datetime('now') WHERE id = ?`).bind(adminRoleId, fromId),
  ]);
const auditPage = (db, limit, offset) =>
  list(db, `SELECT a.created_at, a.action, a.entity_type, a.entity_id, adm.telegram_id AS admin_tg
            FROM audit_logs a LEFT JOIN administrators adm ON adm.id = a.admin_id ORDER BY a.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);

// ======================= إعدادات الملفات =======================
const fileTypesPage = (db, limit, offset) =>
  list(db, 'SELECT extension, is_allowed FROM allowed_file_types ORDER BY extension LIMIT ? OFFSET ?', limit + 1, offset);
const fileType = (db, ext) => db.prepare('SELECT extension, is_allowed FROM allowed_file_types WHERE extension = ?').bind(ext).first();
const setFileTypeAllowed = (db, ext, allowed) => db.prepare('UPDATE allowed_file_types SET is_allowed = ? WHERE extension = ?').bind(allowed ? 1 : 0, ext).run();
const addFileType = (db, ext) => db.prepare('INSERT INTO allowed_file_types (extension, is_allowed) VALUES (?, 1)').bind(ext).run();

const q = { getSetting, claimUpdate, touchUser, universities, colleges, departments, levels, semesters, courses, parentOf, courseCategories, filesOfCourse, crumb, latestFiles, topFiles, visibleFile, recordDownload, getAdmin, rolePerms, getState, setState, clearState, takeState, audit, addCatalog, categories, categoryById, courseInfo, allowedType, duplicateFile, insertFile, adminFiles, adminFile, setFileStatus, setFileTitle, rolesBelow, roleById, adminByTelegram, insertAdmin, listAdmins, libraryStats, setSetting, catalogList, catalogItem, renameCatalog, setCatalogActive, catalogChildCount, deleteCatalog, moveFile, setFileCategory, setFileDescription, usersPage, userById, setUserStatus, userCounts, adminById, setAdminRole, setAdminStatus, adminsList, roleByCode, allPerms, rolePermIds, permById, grantPerm, revokePerm, transferOwnership, auditPage, fileTypesPage, fileType, setFileTypeAllowed, addFileType };

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

// طريقة الإرسال المناسبة لكل نوع وسائط
const SEND = {
  document: ['sendDocument', 'document'],
  photo: ['sendPhoto', 'photo'],
  audio: ['sendAudio', 'audio'],
  video: ['sendVideo', 'video'],
  voice: ['sendVoice', 'voice'],
};

// ===== admin.js =====
// لوحة الإدارة داخل البوت.
// كل عملية تتحقق من الصلاحية في الخادم عند كل ضغطة؛ لا يُعتمد على إخفاء الأزرار.
// الأزرار القديمة في سجل المحادثة لا تعمل إذا سُحبت الصلاحية أو انتهت العملية.

const AP = 8; // عدد العناصر في الصفحة
const NEXT = { u: 'c', c: 'd', d: 'l', l: 's', s: 'k' };
const TITLES = { u: 'الجامعات', c: 'الكليات', d: 'الأقسام', l: 'المستويات', s: 'الفصول', k: 'المواد', g: 'أنواع المحتوى' };
const SINGULAR = { u: 'جامعة', c: 'كلية', d: 'قسم', l: 'مستوى', s: 'فصل', k: 'مادة', g: 'نوع محتوى' };
const ADMIN_HOME = [btn('⚙️ لوحة الإدارة', 'a:menu'), btn('🏠 الرئيسية', 'home')];
const CANCEL_ROW = [btn('✖️ إلغاء', 'a:cancel')];
const FORBIDDEN = 'ليست لديك صلاحية لهذه العملية.';
const permOf = (type) => (type === 'g' ? 'categories.manage' : 'catalog.manage');
const SAFE_MEDIA_EXT = new Set(['mp3', 'm4a', 'ogg', 'wav', 'aac', 'flac', 'opus', 'mp4', 'mov', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'webp']);
const DANGEROUS_EXT = new Set(['exe', 'apk', 'bat', 'cmd', 'com', 'sh', 'js', 'jar', 'msi', 'scr', 'vbs', 'ps1', 'dll', 'iso', 'dmg']);
const MIME_EXT = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

async function loadAdmin(db, tgId) {
  const a = await q.getAdmin(db, tgId);
  if (!a) return null;
  return { ...a, perms: new Set(await q.rolePerms(db, a.role_id)) };
}

const can = (ctx, perm) => !!ctx.admin && ctx.admin.perms.has(perm);
const isOwner = (ctx) => !!ctx.admin && ctx.admin.role === 'owner';
const denied = (env, ctx) => show(env, ctx, FORBIDDEN, [ADMIN_HOME]);
const gone = (env, ctx, what = 'العنصر غير موجود.') => show(env, ctx, what, [ADMIN_HOME]);
const clean = (s, max = 100) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 1 && t.length <= max ? t : null;
};
const isUnique = (e) => /UNIQUE|constraint/i.test(String(e?.message));
const userLabel = (u) => String(u.display_name || (u.username ? `@${u.username}` : u.telegram_id)).slice(0, 40);

// ---------- القائمة الرئيسية للإدارة ----------
function menuRows(ctx) {
  const rows = [];
  const add = (...b) => b.length && rows.push(b);
  if (can(ctx, 'files.create')) add(btn('➕ إضافة ملف', 'a:up'));
  add(...[can(ctx, 'catalog.manage') && btn('🗂 الجامعات والمواد', 'a:n:u:0'), can(ctx, 'categories.manage') && btn('🏷 أنواع المحتوى', 'a:n:g:0')].filter(Boolean));
  add(...[can(ctx, 'files.view') && btn('📄 الملفات', 'a:fl:0'), can(ctx, 'students.view') && btn('👥 الطلاب', 'a:us:0')].filter(Boolean));
  add(...[can(ctx, 'stats.view') && btn('📊 الإحصائيات', 'a:st'), can(ctx, 'audit.view') && btn('📜 سجل العمليات', 'a:lg:0')].filter(Boolean));
  add(...[(can(ctx, 'admins.manage') || can(ctx, 'roles.manage')) && btn('🛡 المشرفون والصلاحيات', 'a:am'), can(ctx, 'settings.edit') && btn('⚙️ الإعدادات', 'a:set')].filter(Boolean));
  add(btn('❓ دليل الإدارة', 'a:help'), btn('🏠 الرئيسية', 'home'));
  return rows;
}
const ROLE_AR = { owner: 'المالك', admin: 'المدير', content_manager: 'مسؤول المحتوى', viewer: 'المشرف المطّلع' };
const showMenu = (env, ctx) => show(env, ctx, `<b>لوحة الإدارة</b>\nدورك: ${esc(ROLE_AR[ctx.admin.role] ?? ctx.admin.role)}\nاختر ما تريد:`, menuRows(ctx));

const GUIDE = `<b>دليل الإدارة السريع</b>
➕ <b>إضافة ملف</b>: اختر المادة ← نوع المحتوى ← أرسل الملف (مستند أو صورة أو صوت أو فيديو) ← العنوان ← تأكيد.
🗂 <b>الجامعات والمواد</b>: أضف وعدّل وأخفِ واحذف: جامعة ← كلية ← قسم ← مستوى ← فصل ← مادة. اضغط ✏️ بجانب أي عنصر.
🏷 <b>أنواع المحتوى</b>: هي الأزرار التي تظهر داخل كل مادة (محاضرات، مراجع، تسجيلات...). أضف وعدّل كما تشاء.
📄 <b>الملفات</b>: إخفاء، حذف، تعديل العنوان والوصف، نقل لمادة أخرى، تغيير النوع.
👥 <b>الطلاب</b>: قائمة الطلاب وحظر من يسيء الاستخدام (للمشرفين فقط).
🛡 <b>المشرفون</b>: إضافة مشرف وتحديد دوره، وتعديل صلاحيات كل دور، ونقل الملكية.
• «إخفاء» يخفي العنصر عن الطلاب دون حذف شيء. أما «الحذف» فلا يتم إلا لما لا يحتوي شيئًا.
• أي عملية تأكيد تُنفَّذ مرة واحدة فقط، والأزرار القديمة في المحادثة لا تكرّرها.
• أرسل /cancel في أي وقت لإلغاء العملية الحالية.`;

// ---------- تصفح التصنيفات (n: إدارة، p: اختيار مادة للرفع، m: اختيار مادة لنقل ملف) ----------
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
  if (type === 'u') return 'a:menu';
  if (type === 'c') return to('u', 0);
  const probe = { d: ['college', 'c'], l: ['department', 'd'], s: ['level', 'l'], k: ['semester', 's'] }[type];
  const r = await q.parentOf[probe[0]](db, parent);
  return r ? to(probe[1], r.p) : to('u', 0);
}

async function navigate(env, ctx, mode, type, parent) {
  if (!TITLES[type] || (type === 'g' && mode !== 'n')) return denied(env, ctx);
  const perm = mode === 'n' ? permOf(type) : mode === 'p' ? 'files.create' : 'files.edit';
  if (!can(ctx, perm)) return denied(env, ctx);

  if (type === 'g') {
    const items = await q.catalogList(env.DB, 'g', 0);
    const rows = items.map((i) => [btn(`${i.is_active === 0 ? '🚫 ' : ''}${catIcon(i.name)} ${i.name}`, `a:i:g:${i.id}`)]);
    rows.push([btn('➕ إضافة نوع محتوى', 'a:+:g:0')]);
    rows.push([btn('⬅️ رجوع', 'a:menu'), btn('🏠 الرئيسية', 'home')]);
    return show(env, ctx, `<b>أنواع المحتوى</b>\nهي الأزرار التي تظهر للطالب داخل كل مادة. اضغط على نوع لتعديله أو إخفائه أو حذفه.`, rows);
  }

  const items = mode === 'n' ? await q.catalogList(env.DB, type, parent) : await children(env.DB, type, parent);
  const rows = [];
  for (const i of items) {
    if (mode === 'n') {
      const label = `${i.is_active === 0 ? '🚫 ' : ''}${i.name}${type === 'k' ? ` (${i.files_count})` : ''}`;
      if (type === 'k') rows.push([btn(label, `a:i:k:${i.id}`)]);
      else rows.push([btn(label, `a:n:${NEXT[type]}:${i.id}`), btn('✏️', `a:i:${type}:${i.id}`)]);
    } else if (type === 'k') rows.push([btn(i.name, mode === 'p' ? `a:uc:${i.id}` : `a:mc:${i.id}`)]);
    else rows.push([btn(i.name, `a:${mode}:${NEXT[type]}:${i.id}`)]);
  }
  if (mode === 'n') rows.push([btn(`➕ إضافة ${SINGULAR[type]}`, `a:+:${type}:${parent}`)]);
  rows.push([btn('⬅️ رجوع', await backFor(env.DB, mode, type, parent)), btn('⚙️ الإدارة', 'a:menu')]);
  const head = mode === 'p' ? 'اختر المادة التي سيُرفع إليها الملف.\n' : mode === 'm' ? 'اختر المادة الجديدة للملف.\n' : 'اضغط على الاسم للدخول، أو ✏️ للتعديل والإخفاء والحذف.\n';
  return show(env, ctx, `${head}${items.length ? `${TITLES[type]}:` : `لا توجد ${TITLES[type]} بعد.`}`, rows);
}

async function itemMenu(env, ctx, type, id) {
  if (!SINGULAR[type] || !can(ctx, permOf(type))) return denied(env, ctx);
  const item = id === null ? null : await q.catalogItem(env.DB, type, id);
  if (!item) return gone(env, ctx);
  const hidden = item.is_active === 0;
  return show(env, ctx,
    `<b>${esc(item.name)}</b> (${SINGULAR[type]})\nالحالة: ${hidden ? 'مخفي عن الطلاب 🚫' : 'ظاهر ✅'}`,
    [[btn('✏️ تعديل الاسم', `a:rn:${type}:${id}`)],
      [hidden ? btn('👁 إظهار', `a:tg:${type}:${id}:s`) : btn('🙈 إخفاء عن الطلاب', `a:tg:${type}:${id}:h`)],
      [btn('🗑 حذف', `a:dl:${type}:${id}`)],
      [btn('⬅️ رجوع', type === 'g' ? 'a:n:g:0' : `a:n:${type}:${item.parent}`), ADMIN_HOME[0]]]);
}

async function loadItem(env, ctx, type, rawId) {
  const id = parseId(rawId);
  if (!SINGULAR[type] || id === null) return null;
  return q.catalogItem(env.DB, type, id).then((it) => (it ? { ...it, id } : null));
}

// ---------- الإدخال النصي والوسائط ----------
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
      if (!can(ctx, permOf(d.type))) return (await denied(env, ctx), true);
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
      if (!can(ctx, permOf('k'))) return (await denied(env, ctx), true);
      const doctor = text === '-' ? null : clean(text);
      if (text !== '-' && !doctor) { await show(env, ctx, 'الاسم غير صالح. أعد الكتابة أو أرسل -', [CANCEL_ROW]); return true; }
      return finishAdd(env, ctx, d, d.name, doctor);
    }
    case 'rn': {
      if (!can(ctx, permOf(d.type))) return (await denied(env, ctx), true);
      const name = clean(text);
      if (!name) { await show(env, ctx, 'الاسم غير صالح. اكتب اسمًا من 1 إلى 100 حرف.', [CANCEL_ROW]); return true; }
      try {
        await q.renameCatalog(db, d.type, d.id, name);
      } catch (e) {
        await show(env, ctx, isUnique(e) ? 'هذا الاسم موجود مسبقًا في نفس المكان. اكتب اسمًا آخر.' : 'تعذّر التعديل.', [CANCEL_ROW]);
        return true;
      }
      await q.clearState(db, ctx.tgId);
      await q.audit(db, ctx.admin.id, `catalog.rename.${d.type}`, 'catalog', d.id, { name });
      await itemMenu(env, ctx, d.type, d.id);
      return true;
    }
    case 'up_file': {
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      return receiveFile(env, ctx, msg, d);
    }
    case 'up_title': {
      const title = clean(text, 200);
      if (!title) { await show(env, ctx, 'العنوان غير صالح (حتى 200 حرف).', [CANCEL_ROW]); return true; }
      await q.setState(db, ctx.tgId, 'up_desc', { ...d, title });
      await show(env, ctx, 'اكتب وصفًا مختصرًا للملف، أو اضغط «تخطي الوصف».', [[btn('⏭ تخطي الوصف', 'a:uds')], CANCEL_ROW]);
      return true;
    }
    case 'up_desc': {
      const description = text === '-' ? null : clean(text, 1000);
      if (text !== '-' && !description) { await show(env, ctx, 'الوصف غير صالح. أعد الكتابة أو اضغط «تخطي الوصف».', [[btn('⏭ تخطي الوصف', 'a:uds')], CANCEL_ROW]); return true; }
      await toConfirm(env, ctx, { ...d, description });
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
    case 'edit_desc': {
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const desc = text === '-' ? null : clean(text, 1000);
      if (text !== '-' && !desc) { await show(env, ctx, 'الوصف غير صالح (حتى 1000 حرف). أرسل - لحذف الوصف.', [CANCEL_ROW]); return true; }
      await q.clearState(db, ctx.tgId);
      await q.setFileDescription(db, d.id, desc);
      await q.audit(db, ctx.admin.id, 'file.edit.description', 'file', d.id, null);
      await show(env, ctx, 'تم تعديل الوصف ✅', [[btn('📄 الملف', `a:fv:${d.id}`)], ADMIN_HOME]);
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
    case 'tr_confirm': {
      await q.clearState(db, ctx.tgId);
      if (text !== 'نقل') { await show(env, ctx, 'لم يتم نقل الملكية (لم تكتب كلمة التأكيد).', [ADMIN_HOME]); return true; }
      return executeTransfer(env, ctx, d.target);
    }
    case 'set_size': {
      if (!can(ctx, 'settings.edit')) return (await denied(env, ctx), true);
      const mb = Number(text);
      if (!Number.isInteger(mb) || mb < 1 || mb > 2000) { await show(env, ctx, 'اكتب رقمًا صحيحًا بالميغابايت بين 1 و2000.', [CANCEL_ROW]); return true; }
      await q.clearState(db, ctx.tgId);
      await q.setSetting(db, 'max_file_size_bytes', mb * 1024 * 1024, ctx.admin.id);
      await q.audit(db, ctx.admin.id, 'settings.max_size', 'setting', 'max_file_size_bytes', { mb });
      await show(env, ctx, `تم ضبط الحد الأقصى لحجم الملف: ${mb} م.ب ✅`, [[btn('⬅️ الإعدادات', 'a:set')], ADMIN_HOME]);
      return true;
    }
    case 'ft_add': {
      if (!can(ctx, 'settings.security')) return (await denied(env, ctx), true);
      const ext = text.toLowerCase().replace(/^\./, '');
      if (!/^[a-z0-9]{1,10}$/.test(ext)) { await show(env, ctx, 'اكتب امتدادًا بالحروف الإنجليزية والأرقام فقط (مثل pdf).', [CANCEL_ROW]); return true; }
      if (DANGEROUS_EXT.has(ext)) { await show(env, ctx, 'لا يمكن السماح بهذا النوع لأسباب أمنية.', [CANCEL_ROW]); return true; }
      await q.clearState(db, ctx.tgId);
      try { await q.addFileType(db, ext); } catch (e) { await show(env, ctx, 'هذا الامتداد موجود مسبقًا.', [[btn('⬅️ الأنواع', 'a:ft:0')], ADMIN_HOME]); return true; }
      await q.audit(db, ctx.admin.id, 'settings.filetype.add', 'setting', ext, null);
      await show(env, ctx, `تمت إضافة النوع .${ext} ✅`, [[btn('⬅️ الأنواع', 'a:ft:0')], ADMIN_HOME]);
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
    await show(env, ctx, `تمت إضافة ${SINGULAR[d.type]}: <b>${esc(name)}</b> ✅`,
      [[btn('➕ إضافة أخرى', `a:+:${d.type}:${d.parent}`)], [btn('⬅️ القائمة', `a:n:${d.type}:${d.parent}`)], ADMIN_HOME]);
  } catch (e) {
    const msg = isUnique(e) ? 'هذا الاسم موجود مسبقًا في نفس المكان.' : 'تعذّرت الإضافة. تأكد أن التصنيف الأعلى ما زال موجودًا.';
    if (!isUnique(e)) console.error('addCatalog failed:', redact(e.message, env));
    await show(env, ctx, msg, [ADMIN_HOME]);
  }
  return true;
}

// ---------- استقبال الملفات بأنواعها ----------
function pickMedia(msg) {
  if (msg.document) return { kind: 'document', o: msg.document };
  if (msg.audio) return { kind: 'audio', o: msg.audio };
  if (msg.voice) return { kind: 'voice', o: msg.voice };
  if (msg.video) return { kind: 'video', o: msg.video };
  if (Array.isArray(msg.photo) && msg.photo.length) return { kind: 'photo', o: msg.photo[msg.photo.length - 1] };
  return null;
}
function extOf(kind, o) {
  const fromName = (/\.([A-Za-z0-9]{1,10})$/.exec(o.file_name ?? '') ?? [])[1]?.toLowerCase();
  if (kind === 'document') return fromName;
  if (fromName && SAFE_MEDIA_EXT.has(fromName)) return fromName;
  return kind === 'photo' ? 'jpg' : kind === 'voice' ? 'ogg' : kind === 'video' ? 'mp4' : MIME_EXT[o.mime_type] ?? 'mp3';
}

async function receiveFile(env, ctx, msg, d) {
  const db = env.DB;
  const media = pickMedia(msg);
  if (!media) { await show(env, ctx, 'أرسل الملف الآن: مستند أو صورة أو تسجيل صوتي أو فيديو.', [CANCEL_ROW]); return true; }
  const { kind, o } = media;
  const ext = extOf(kind, o);
  const maxSize = Number(await q.getSetting(db, 'max_file_size_bytes', '20971520'));
  let limit = maxSize;
  if (kind === 'document') {
    const type = ext ? await q.allowedType(db, ext) : null;
    if (!type) { await show(env, ctx, 'نوع الملف غير مسموح به أو غير معروف. يمكن تعديل الأنواع المسموحة من الإعدادات.', [CANCEL_ROW]); return true; }
    if (type.max_size_bytes) limit = Math.min(maxSize, type.max_size_bytes);
    if (!Number.isFinite(o.file_size)) { await show(env, ctx, 'تعذّر معرفة حجم الملف.', [CANCEL_ROW]); return true; }
  }
  if (Number.isFinite(o.file_size) && o.file_size > limit) {
    await show(env, ctx, `حجم الملف يتجاوز الحد المسموح (${fmtSize(limit)}).`, [CANCEL_ROW]);
    return true;
  }
  const dup = await q.duplicateFile(db, o.file_unique_id);
  if (dup) { await show(env, ctx, `هذا الملف موجود مسبقًا في المكتبة باسم: <b>${esc(dup.title)}</b>`, [CANCEL_ROW]); return true; }
  const base = String(o.file_name ?? '').replace(/\.[^.]+$/, '');
  await q.setState(db, ctx.tgId, 'up_title', {
    ...d, media_kind: kind, extension: ext, mime_type: o.mime_type ?? null, size_bytes: o.file_size ?? 0,
    tg_file_id: o.file_id, tg_file_unique_id: o.file_unique_id, file_name: base.slice(0, 200),
  });
  const rows = [];
  if (base) rows.push([btn('📎 استخدم اسم الملف عنوانًا', 'a:utd')]);
  rows.push(CANCEL_ROW);
  await show(env, ctx, 'اكتب عنوان الملف كما سيظهر للطلاب.', rows);
  return true;
}

async function toConfirm(env, ctx, nd) {
  await q.setState(env.DB, ctx.tgId, 'up_confirm', nd);
  const course = await q.courseInfo(env.DB, nd.course_id);
  const cat = await q.categoryById(env.DB, nd.category_id);
  const KIND_AR = { document: 'ملف', photo: 'صورة', audio: 'صوت', video: 'فيديو', voice: 'رسالة صوتية' };
  return show(env, ctx,
    `<b>مراجعة قبل النشر</b>\nالعنوان: ${esc(nd.title)}\nالمادة: ${esc(course?.name)}\nنوع المحتوى: ${esc(cat?.name)}\n` +
    `النوع: ${esc(KIND_AR[nd.media_kind] ?? 'ملف')} ${esc(String(nd.extension ?? '').toUpperCase())}  |  الحجم: ${fmtSize(nd.size_bytes)}\n${nd.description ? `الوصف: ${esc(nd.description)}` : 'بدون وصف'}`,
    [[btn('✅ تأكيد النشر', 'a:uok')], CANCEL_ROW]);
}

// ---------- الأزرار ----------
async function adminCallback(env, ctx, data) {
  const db = env.DB;
  if (!ctx.admin) return false; // الطلاب: تجاهل كامل
  const [, cmd, a, b, c] = data.split(':');

  switch (cmd) {
    case 'menu': await q.clearState(db, ctx.tgId); return (await showMenu(env, ctx), true);
    case 'cancel': await q.clearState(db, ctx.tgId); return (await show(env, ctx, 'تم الإلغاء.', [ADMIN_HOME]), true);
    case 'noop': return true;
    case 'help': return (await show(env, ctx, GUIDE, [ADMIN_HOME]), true);

    // ----- التصنيفات -----
    case 'n': case 'p': case 'm': {
      const parent = parseId(b);
      if (!TITLES[a] || parent === null) return (await denied(env, ctx), true);
      return (await navigate(env, ctx, cmd, a, parent), true);
    }
    case '+': {
      const parent = parseId(b);
      if (!TITLES[a] || parent === null || !can(ctx, permOf(a))) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'add_name', { type: a, parent });
      return (await show(env, ctx, `اكتب اسم ${SINGULAR[a]} الجديد (حتى 100 حرف):`, [CANCEL_ROW]), true);
    }
    case 'i': return (await itemMenu(env, ctx, a, parseId(b)), true);
    case 'rn': {
      if (!SINGULAR[a] || !can(ctx, permOf(a))) return (await denied(env, ctx), true);
      const item = await loadItem(env, ctx, a, b);
      if (!item) return (await gone(env, ctx), true);
      await q.setState(db, ctx.tgId, 'rn', { type: a, id: item.id });
      return (await show(env, ctx, `الاسم الحالي: <b>${esc(item.name)}</b>\nاكتب الاسم الجديد:`, [CANCEL_ROW]), true);
    }
    case 'tg': { // إخفاء/إظهار: s=إظهار، h=إخفاء (بلا علامة = تبديل). الضغط المتكرر لا يقلب الحالة.
      if (!SINGULAR[a] || !can(ctx, permOf(a))) return (await denied(env, ctx), true);
      const item = await loadItem(env, ctx, a, b);
      if (!item) return (await gone(env, ctx), true);
      const wantActive = c === 's' ? true : c === 'h' ? false : item.is_active === 0;
      if ((item.is_active === 1) !== wantActive) {
        await q.setCatalogActive(db, a, item.id, wantActive);
        await q.audit(db, ctx.admin.id, wantActive ? `catalog.show.${a}` : `catalog.hide.${a}`, 'catalog', item.id, null);
      }
      return (await itemMenu(env, ctx, a, item.id), true);
    }
    case 'dl': {
      if (!SINGULAR[a] || !can(ctx, permOf(a))) return (await denied(env, ctx), true);
      const item = await loadItem(env, ctx, a, b);
      if (!item) return (await gone(env, ctx), true);
      const n = await q.catalogChildCount(db, a, item.id);
      if (n > 0) {
        const what = a === 'k' || a === 'g' ? 'ملفات مرتبطة به (حتى المحذوفة منطقيًا تُحفظ سجلاتها)' : 'عناصر بداخله';
        return (await show(env, ctx, `لا يمكن حذف <b>${esc(item.name)}</b>: فيه ${n} من ${what}.\nاحذف ما بداخله أولًا، أو استخدم «إخفاء عن الطلاب».`,
          [[btn('🙈 إخفاء بدل الحذف', `a:tg:${a}:${item.id}:h`)], [btn('⬅️ رجوع', `a:i:${a}:${item.id}`)]]), true);
      }
      return (await show(env, ctx, `هل تريد حذف <b>${esc(item.name)}</b> نهائيًا؟\nلا يمكن التراجع عن هذا الحذف.`,
        [[btn('🗑 نعم، احذف', `a:dy:${a}:${item.id}`)], [btn('إلغاء', `a:i:${a}:${item.id}`)]]), true);
    }
    case 'dy': {
      if (!SINGULAR[a] || !can(ctx, permOf(a))) return (await denied(env, ctx), true);
      const item = await loadItem(env, ctx, a, b);
      if (!item) return (await gone(env, ctx, 'تم حذف هذا العنصر من قبل.'), true);
      if ((await q.catalogChildCount(db, a, item.id)) > 0) return (await gone(env, ctx, 'لا يمكن الحذف: توجد عناصر مرتبطة.'), true);
      try {
        await q.deleteCatalog(db, a, item.id);
      } catch (e) {
        console.error('deleteCatalog failed:', redact(e.message, env));
        return (await show(env, ctx, 'لا يمكن الحذف لوجود بيانات مرتبطة. استخدم «إخفاء عن الطلاب».', [[btn('⬅️ رجوع', `a:i:${a}:${item.id}`)]]), true);
      }
      await q.audit(db, ctx.admin.id, `catalog.delete.${a}`, 'catalog', item.id, { name: item.name });
      return (await show(env, ctx, `تم حذف <b>${esc(item.name)}</b> ✅`, [[btn('⬅️ القائمة', a === 'g' ? 'a:n:g:0' : `a:n:${a}:${item.parent}`)], ADMIN_HOME]), true);
    }

    // ----- رفع ملف -----
    case 'up': return (await navigate(env, ctx, 'p', 'u', 0), true);
    case 'uc': {
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      const course = parseId(a) === null ? null : await q.courseInfo(db, parseId(a));
      if (!course) return (await gone(env, ctx, 'المادة غير موجودة.'), true);
      const cats = await q.categories(db);
      return (await show(env, ctx, `المادة: <b>${esc(course.name)}</b>\nاختر نوع المحتوى:`,
        [...cats.map((c) => [btn(`${catIcon(c.name)} ${c.name}`, `a:ut:${course.id}:${c.id}`)]), CANCEL_ROW]), true);
    }
    case 'ut': {
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      const course = parseId(a) === null ? null : await q.courseInfo(db, parseId(a));
      const cat = parseId(b) === null ? null : await q.categoryById(db, parseId(b));
      if (!course || !cat) return (await gone(env, ctx, 'اختيار غير صالح.'), true);
      await q.setState(db, ctx.tgId, 'up_file', { course_id: course.id, category_id: cat.id });
      return (await show(env, ctx, `المادة: <b>${esc(course.name)}</b> | النوع: ${esc(cat.name)}\nأرسل الملف الآن: مستند أو صورة أو تسجيل صوتي أو فيديو.`, [CANCEL_ROW]), true);
    }
    case 'utd': { // استخدام اسم الملف كعنوان
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      const st = await q.getState(db, ctx.tgId);
      if (!st || st.state !== 'up_title') return (await gone(env, ctx, 'انتهت العملية. ابدأ من جديد.'), true);
      const d = JSON.parse(st.data);
      const title = clean(d.file_name, 200) ?? 'ملف';
      await q.setState(db, ctx.tgId, 'up_desc', { ...d, title });
      return (await show(env, ctx, `العنوان: <b>${esc(title)}</b>\nاكتب وصفًا مختصرًا للملف، أو اضغط «تخطي الوصف».`, [[btn('⏭ تخطي الوصف', 'a:uds')], CANCEL_ROW]), true);
    }
    case 'uds': { // تخطي الوصف
      if (!can(ctx, 'files.create')) return (await denied(env, ctx), true);
      const st = await q.getState(db, ctx.tgId);
      if (!st || st.state !== 'up_desc') return (await gone(env, ctx, 'انتهت العملية. ابدأ من جديد.'), true);
      return (await toConfirm(env, ctx, { ...JSON.parse(st.data), description: null }), true);
    }
    case 'ucancel': await q.clearState(db, ctx.tgId); return (await show(env, ctx, 'تم إلغاء الرفع.', [ADMIN_HOME]), true);
    case 'uok': return (await confirmUpload(env, ctx), true);

    // ----- إدارة الملفات -----
    case 'fl': {
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
    case 'fh': case 'fp': {
      if (!can(ctx, 'files.hide')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await gone(env, ctx, 'الملف غير موجود.'), true);
      const status = cmd === 'fh' ? 'hidden' : 'published';
      await q.setFileStatus(db, id, status, ctx.admin.id);
      await q.audit(db, ctx.admin.id, status === 'hidden' ? 'file.hide' : 'file.publish', 'file', id, null);
      return (await fileAdminCard(env, ctx, id), true);
    }
    case 'fd': {
      if (!can(ctx, 'files.delete')) return (await denied(env, ctx), true);
      const f = parseId(a) === null ? null : await q.adminFile(db, parseId(a));
      if (!f) return (await gone(env, ctx, 'الملف غير موجود.'), true);
      return (await show(env, ctx, `هل تريد حذف الملف <b>${esc(f.title)}</b>؟\nهذا حذف منطقي: تبقى سجلاته، ولا تُحذف نسخة الأرشيف.`,
        [[btn('🗑 نعم، احذف', `a:fy:${f.id}`)], [btn('إلغاء', `a:fv:${f.id}`)]]), true);
    }
    case 'fy': {
      if (!can(ctx, 'files.delete')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await gone(env, ctx, 'الملف غير موجود أو حُذف من قبل.'), true);
      await q.setFileStatus(db, id, 'deleted', ctx.admin.id);
      await q.audit(db, ctx.admin.id, 'file.delete', 'file', id, null);
      return (await show(env, ctx, 'تم حذف الملف ✅', [[btn('📄 الملفات', 'a:fl:0')], ADMIN_HOME]), true);
    }
    case 'fe': case 'fo': {
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await gone(env, ctx, 'الملف غير موجود.'), true);
      await q.setState(db, ctx.tgId, cmd === 'fe' ? 'edit_title' : 'edit_desc', { id });
      return (await show(env, ctx, cmd === 'fe' ? 'اكتب العنوان الجديد للملف:' : 'اكتب الوصف الجديد للملف (أو أرسل - لحذف الوصف):', [CANCEL_ROW]), true);
    }
    case 'fm': { // نقل الملف لمادة أخرى
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const id = parseId(a);
      if (id === null || !(await q.adminFile(db, id))) return (await gone(env, ctx, 'الملف غير موجود.'), true);
      await q.setState(db, ctx.tgId, 'mv', { file_id: id });
      return (await navigate(env, ctx, 'm', 'u', 0), true);
    }
    case 'mc': {
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const st = await q.getState(db, ctx.tgId);
      if (!st || st.state !== 'mv') return (await gone(env, ctx, 'انتهت العملية. ابدأ من جديد.'), true);
      const course = parseId(a) === null ? null : await q.courseInfo(db, parseId(a));
      const fileId = JSON.parse(st.data).file_id;
      if (!course || !(await q.adminFile(db, fileId))) return (await gone(env, ctx, 'تعذّر النقل: المادة أو الملف غير موجود.'), true);
      await q.clearState(db, ctx.tgId);
      await q.moveFile(db, fileId, course.id);
      await q.audit(db, ctx.admin.id, 'file.move', 'file', fileId, { course_id: course.id });
      return (await fileAdminCard(env, ctx, fileId), true);
    }
    case 'fc': { // تغيير نوع المحتوى
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const id = parseId(a);
      const f = id === null ? null : await q.adminFile(db, id);
      if (!f) return (await gone(env, ctx, 'الملف غير موجود.'), true);
      const cats = await q.categories(db);
      return (await show(env, ctx, `اختر نوع المحتوى الجديد للملف <b>${esc(f.title)}</b>:`,
        [...cats.map((c) => [btn(`${catIcon(c.name)} ${c.name}`, `a:fk:${id}:${c.id}`)]), [btn('⬅️ رجوع', `a:fv:${id}`)]]), true);
    }
    case 'fk': {
      if (!can(ctx, 'files.edit')) return (await denied(env, ctx), true);
      const id = parseId(a);
      const cat = parseId(b) === null ? null : await q.categoryById(db, parseId(b));
      if (id === null || !cat || !(await q.adminFile(db, id))) return (await gone(env, ctx, 'اختيار غير صالح.'), true);
      await q.setFileCategory(db, id, cat.id);
      await q.audit(db, ctx.admin.id, 'file.category', 'file', id, { category_id: cat.id });
      return (await fileAdminCard(env, ctx, id), true);
    }

    // ----- الإحصائيات والسجل -----
    case 'st': {
      if (!can(ctx, 'stats.view')) return (await denied(env, ctx), true);
      const s = await q.libraryStats(db);
      return (await show(env, ctx,
        `<b>الإحصائيات</b>\nالطلاب: ${s.users} (جدد اليوم: ${s.newToday})\nالملفات المنشورة: ${s.files}\nالتنزيلات: ${s.downloads} (اليوم: ${s.downloadsToday})`, [ADMIN_HOME]), true);
    }
    case 'lg': {
      if (!can(ctx, 'audit.view')) return (await denied(env, ctx), true);
      const page = Math.min(parseId(a) ?? 0, 1000);
      const items = await q.auditPage(db, 10, page * 10);
      const lines = items.slice(0, 10).map((r) => `${esc(String(r.created_at).slice(5, 16))} | ${esc(r.action)} | ${esc(r.entity_type)}${r.entity_id ? `#${esc(r.entity_id)}` : ''} | ${esc(r.admin_tg ?? '-')}`);
      const nav = [];
      if (page > 0) nav.push(btn('◀️ الأحدث', `a:lg:${page - 1}`));
      if (items.length > 10) nav.push(btn('الأقدم ▶️', `a:lg:${page + 1}`));
      return (await show(env, ctx, `<b>سجل العمليات</b> (الأحدث أولًا)\n${lines.join('\n') || 'لا توجد عمليات.'}`, [...(nav.length ? [nav] : []), ADMIN_HOME]), true);
    }

    // ----- الطلاب (للمشرفين فقط) -----
    case 'us': {
      if (!can(ctx, 'students.view')) return (await denied(env, ctx), true);
      const page = Math.min(parseId(a) ?? 0, 1000);
      const items = await q.usersPage(db, AP, page * AP);
      const counts = await q.userCounts(db);
      const rows = items.slice(0, AP).map((u) => [btn(`${u.status === 'blocked' ? '🚫 ' : ''}${userLabel(u)}`, `a:uv:${u.id}`)]);
      const nav = [];
      if (page > 0) nav.push(btn('◀️ السابق', `a:us:${page - 1}`));
      if (items.length > AP) nav.push(btn('التالي ▶️', `a:us:${page + 1}`));
      if (nav.length) rows.push(nav);
      rows.push(ADMIN_HOME);
      return (await show(env, ctx, `<b>الطلاب</b>\nالمجموع: ${counts.total} (محظور: ${counts.blocked})\nالأحدث نشاطًا أولًا:`, rows), true);
    }
    case 'uv': {
      if (!can(ctx, 'students.view')) return (await denied(env, ctx), true);
      const u = parseId(a) === null ? null : await q.userById(db, parseId(a));
      if (!u) return (await gone(env, ctx, 'الطالب غير موجود.'), true);
      const rows = [];
      if (can(ctx, 'students.manage')) rows.push([u.status === 'blocked' ? btn('✅ إلغاء الحظر', `a:ub:${u.id}:a`) : btn('🚫 حظر الطالب', `a:ub:${u.id}:b`)]);
      rows.push([btn('⬅️ الطلاب', 'a:us:0'), ADMIN_HOME[0]]);
      return (await show(env, ctx,
        `<b>${esc(userLabel(u))}</b>\nرقم Telegram: ${esc(u.telegram_id)}\n${u.username ? `المعرّف: @${esc(u.username)}\n` : ''}أول استخدام: ${esc(String(u.first_seen_at).slice(0, 16))}\nآخر نشاط: ${esc(String(u.last_active_at).slice(0, 16))}\nعدد التنزيلات: ${u.downloads}\nالحالة: ${u.status === 'blocked' ? 'محظور 🚫' : 'نشط ✅'}`, rows), true);
    }
    case 'ub': { // b=حظر، a=إلغاء الحظر (بلا علامة = تبديل)
      if (!can(ctx, 'students.manage')) return (await denied(env, ctx), true);
      const u = parseId(a) === null ? null : await q.userById(db, parseId(a));
      if (!u) return (await gone(env, ctx, 'الطالب غير موجود.'), true);
      if (u.telegram_id === ctx.tgId) return (await denied(env, ctx), true);
      const next = b === 'b' ? 'blocked' : b === 'a' ? 'active' : u.status === 'blocked' ? 'active' : 'blocked';
      if (next !== u.status) {
        await q.setUserStatus(db, u.id, next);
        await q.audit(db, ctx.admin.id, next === 'blocked' ? 'student.block' : 'student.unblock', 'user', u.id, null);
      }
      return (await show(env, ctx, next === 'blocked' ? 'الطالب الآن محظور 🚫' : 'الطالب الآن غير محظور ✅', [[btn('⬅️ الطالب', `a:uv:${u.id}`)], ADMIN_HOME]), true);
    }

    // ----- المشرفون والصلاحيات -----
    case 'am': {
      if (!can(ctx, 'admins.manage') && !can(ctx, 'roles.manage')) return (await denied(env, ctx), true);
      const rows = [];
      if (can(ctx, 'admins.manage')) rows.push([btn('👥 قائمة المشرفين', 'a:al'), btn('➕ إضافة مشرف', 'a:ad')]);
      if (can(ctx, 'roles.manage')) rows.push([btn('🧩 صلاحيات الأدوار', 'a:rl')]);
      if (isOwner(ctx)) rows.push([btn('👑 نقل الملكية', 'a:tr')]);
      rows.push(ADMIN_HOME);
      return (await show(env, ctx, '<b>المشرفون والصلاحيات</b>', rows), true);
    }
    case 'al': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const list = await q.adminsList(db);
      const rows = list.map((x) => [btn(`${x.status === 'active' ? '✅' : '⛔'} ${x.telegram_id} — ${x.name_ar}`, `a:av:${x.id}`)]);
      rows.push([btn('⬅️ رجوع', 'a:am'), ADMIN_HOME[0]]);
      return (await show(env, ctx, '<b>المشرفون</b> (اضغط على مشرف لإدارته):', rows), true);
    }
    case 'av': return (await adminCard(env, ctx, parseId(a)), true);
    case 'ac': { // تغيير دور مشرف
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const t = parseId(a) === null ? null : await q.adminById(db, parseId(a));
      if (!t || !manageable(ctx, t)) return (await denied(env, ctx), true);
      const roles = await q.rolesBelow(db, ctx.admin.rank);
      return (await show(env, ctx, `اختر الدور الجديد للمشرف ${t.telegram_id}:`,
        [...roles.map((r) => [btn(r.name_ar, `a:as:${t.id}:${r.id}`)]), [btn('⬅️ رجوع', `a:av:${t.id}`)]]), true);
    }
    case 'as': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const t = parseId(a) === null ? null : await q.adminById(db, parseId(a));
      const role = parseId(b) === null ? null : await q.roleById(db, parseId(b));
      if (!t || !role || !manageable(ctx, t) || role.rank >= ctx.admin.rank) return (await denied(env, ctx), true); // لا يمنح أعلى من صلاحيته
      await q.setAdminRole(db, t.id, role.id);
      await q.audit(db, ctx.admin.id, 'admin.role', 'administrator', t.id, { role: role.code });
      return (await adminCard(env, ctx, t.id), true);
    }
    case 'ax': { // إيقاف / تفعيل مشرف
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const t = parseId(a) === null ? null : await q.adminById(db, parseId(a));
      if (!t || !manageable(ctx, t)) return (await denied(env, ctx), true);
      const next = b === 'd' ? 'disabled' : b === 'e' ? 'active' : t.status === 'active' ? 'disabled' : 'active'; // d=إيقاف، e=تفعيل
      if (next !== t.status) {
        await q.setAdminStatus(db, t.id, next);
        if (next === 'disabled') await q.clearState(db, t.telegram_id); // إنهاء أي عملية جارية له
        await q.audit(db, ctx.admin.id, next === 'disabled' ? 'admin.disable' : 'admin.enable', 'administrator', t.id, null);
      }
      return (await adminCard(env, ctx, t.id), true);
    }
    case 'ad': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'adm_id', {});
      return (await show(env, ctx, 'أرسل رقم حساب Telegram للمشرف الجديد (يعرفه بإرسال Start إلى @userinfobot).', [CANCEL_ROW]), true);
    }
    case 'ar': {
      if (!can(ctx, 'admins.manage')) return (await denied(env, ctx), true);
      const st = await q.takeState(db, ctx.tgId, 'adm_role');
      if (!st) return (await gone(env, ctx, 'انتهت العملية. ابدأ من جديد.'), true);
      const role = parseId(a) === null ? null : await q.roleById(db, parseId(a));
      if (!role || role.rank >= ctx.admin.rank) return (await denied(env, ctx), true);
      const { tg: newTg } = JSON.parse(st.data);
      try {
        await q.insertAdmin(db, newTg, role.id, ctx.admin.id);
        await q.audit(db, ctx.admin.id, 'admin.add', 'administrator', newTg, { role: role.code });
        return (await show(env, ctx, `تمت إضافة المشرف ${newTg} بدور ${esc(role.name_ar)} ✅`, [ADMIN_HOME]), true);
      } catch (e) {
        return (await show(env, ctx, 'تعذّرت الإضافة (ربما سُجِّل مسبقًا).', [ADMIN_HOME]), true);
      }
    }
    case 'rl': {
      if (!can(ctx, 'roles.manage')) return (await denied(env, ctx), true);
      const roles = await q.rolesBelow(db, ctx.admin.rank);
      return (await show(env, ctx, '<b>صلاحيات الأدوار</b>\nاختر دورًا لتعديل صلاحياته (يسري التعديل فورًا على كل من يحمل هذا الدور):',
        [...roles.map((r) => [btn(r.name_ar, `a:rp:${r.id}`)]), [btn('⬅️ رجوع', 'a:am')]]), true);
    }
    case 'rp': return (await rolePermsView(env, ctx, parseId(a)), true);
    case 'rt': {
      if (!can(ctx, 'roles.manage')) return (await denied(env, ctx), true);
      const role = parseId(a) === null ? null : await q.roleById(db, parseId(a));
      const perm = parseId(b) === null ? null : await q.permById(db, parseId(b));
      if (!role || !perm || role.rank >= ctx.admin.rank) return (await denied(env, ctx), true);
      if (perm.code === 'roles.manage' || !ctx.admin.perms.has(perm.code)) return (await denied(env, ctx), true); // لا يمنح ما لا يملكه، ولا صلاحية تعديل الأدوار
      const has = (await q.rolePermIds(db, role.id)).has(perm.id);
      const grant = c === '1' ? true : c === '0' ? false : !has; // 1=منح، 0=سحب (بلا علامة = تبديل)
      if (grant !== has) {
        if (grant) await q.grantPerm(db, role.id, perm.id); else await q.revokePerm(db, role.id, perm.id);
        await q.audit(db, ctx.admin.id, grant ? 'role.perm.grant' : 'role.perm.revoke', 'role', role.id, { perm: perm.code });
      }
      return (await rolePermsView(env, ctx, role.id), true);
    }
    case 'tr': {
      if (!isOwner(ctx)) return (await denied(env, ctx), true);
      const list = (await q.adminsList(db)).filter((x) => x.status === 'active' && x.id !== ctx.admin.id);
      if (!list.length) return (await show(env, ctx, 'لا يوجد مشرف آخر فعّال لنقل الملكية إليه. أضف مشرفًا أولًا.', [[btn('⬅️ رجوع', 'a:am')]]), true);
      return (await show(env, ctx, '<b>نقل الملكية</b>\nاختر المشرف الذي ستنتقل إليه ملكية المكتبة:',
        [...list.map((x) => [btn(`${x.telegram_id} — ${x.name_ar}`, `a:tp:${x.id}`)]), [btn('⬅️ رجوع', 'a:am')]]), true);
    }
    case 'tp': {
      if (!isOwner(ctx)) return (await denied(env, ctx), true);
      const t = parseId(a) === null ? null : await q.adminById(db, parseId(a));
      if (!t || t.status !== 'active' || t.id === ctx.admin.id) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'tr_confirm', { target: t.id });
      return (await show(env, ctx,
        `⚠️ <b>تحذير: نقل ملكية المكتبة</b>\nستنتقل الملكية إلى المشرف <b>${esc(t.telegram_id)}</b>، ويصبح دورك «مدير» فتفقد صلاحيات المالك (ومنها نقل الملكية وتعديل الأدوار)، ولا يمكنك استعادتها إلا بموافقته.\n\nللتأكيد اكتب كلمة: <b>نقل</b>\nولإلغاء العملية اضغط إلغاء.`, [CANCEL_ROW]), true);
    }

    // ----- الإعدادات -----
    case 'set': {
      if (!can(ctx, 'settings.edit')) return (await denied(env, ctx), true);
      const size = Number(await q.getSetting(db, 'max_file_size_bytes', '20971520'));
      const arch = await q.getSetting(db, 'archive_chat_id', '');
      return (await show(env, ctx, `<b>إعدادات المكتبة</b>\nالحد الأقصى لحجم الملف: ${fmtSize(size)}\nقناة الأرشيف: ${arch || env.ARCHIVE_CHANNEL_ID ? 'مضبوطة ✅' : 'غير مضبوطة ⚠️ (أعد توجيه منشور من القناة إلى البوت)'}`,
        [[btn('📏 حد حجم الملف', 'a:sz')], [btn('📎 أنواع الملفات المسموحة', 'a:ft:0')], ADMIN_HOME]), true);
    }
    case 'sz': {
      if (!can(ctx, 'settings.edit')) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'set_size', {});
      return (await show(env, ctx, 'اكتب الحد الأقصى لحجم الملف بالميغابايت (رقم من 1 إلى 2000):', [CANCEL_ROW]), true);
    }
    case 'ft': {
      if (!can(ctx, 'settings.edit')) return (await denied(env, ctx), true);
      const page = Math.min(parseId(a) ?? 0, 100);
      const items = await q.fileTypesPage(db, 12, page * 12);
      const rows = items.slice(0, 12).map((t) => [btn(`${t.is_allowed ? '✅' : '⛔'} .${t.extension}`, `a:fx:${t.extension}:${t.is_allowed ? 0 : 1}`)]);
      const nav = [];
      if (page > 0) nav.push(btn('◀️ السابق', `a:ft:${page - 1}`));
      if (items.length > 12) nav.push(btn('التالي ▶️', `a:ft:${page + 1}`));
      if (nav.length) rows.push(nav);
      if (can(ctx, 'settings.security')) rows.push([btn('➕ إضافة نوع', 'a:fa')]);
      rows.push([btn('⬅️ الإعدادات', 'a:set'), ADMIN_HOME[1]]);
      return (await show(env, ctx, 'الأنواع المسموح رفعها كمستندات (✅ مسموح، ⛔ ممنوع). اضغط على نوع لتبديل حالته:', rows), true);
    }
    case 'fx': { // b: 1=سماح، 0=منع (بلا علامة = تبديل)
      if (!can(ctx, 'settings.security')) return (await denied(env, ctx), true);
      const ext = String(a ?? '');
      const t = /^[a-z0-9]{1,10}$/.test(ext) ? await q.fileType(db, ext) : null;
      if (!t) return (await gone(env, ctx, 'النوع غير موجود.'), true);
      const allow = b === '1' ? true : b === '0' ? false : !t.is_allowed;
      if (allow && DANGEROUS_EXT.has(ext)) return (await show(env, ctx, 'لا يمكن السماح بهذا النوع لأسباب أمنية.', [[btn('⬅️ الأنواع', 'a:ft:0')]]), true);
      if (allow !== !!t.is_allowed) {
        await q.setFileTypeAllowed(db, ext, allow);
        await q.audit(db, ctx.admin.id, allow ? 'settings.filetype.allow' : 'settings.filetype.block', 'setting', ext, null);
      }
      return (await show(env, ctx, `.${ext}: ${allow ? 'مسموح ✅' : 'ممنوع ⛔'}`, [[btn('⬅️ الأنواع', 'a:ft:0')], ADMIN_HOME]), true);
    }
    case 'fa': {
      if (!can(ctx, 'settings.security')) return (await denied(env, ctx), true);
      await q.setState(db, ctx.tgId, 'ft_add', {});
      return (await show(env, ctx, 'اكتب امتداد النوع الجديد بالإنجليزية (مثل pdf):', [CANCEL_ROW]), true);
    }
    default: return false;
  }
}

const manageable = (ctx, t) => !!t && t.id !== ctx.admin.id && t.rank < ctx.admin.rank;

async function adminCard(env, ctx, id) {
  if (!can(ctx, 'admins.manage')) return denied(env, ctx);
  const t = id === null ? null : await q.adminById(env.DB, id);
  if (!t) return gone(env, ctx, 'المشرف غير موجود.');
  const rows = [];
  if (manageable(ctx, t)) {
    rows.push([btn('🔁 تغيير الدور', `a:ac:${t.id}`)]);
    rows.push([t.status === 'active' ? btn('⛔ إيقاف المشرف', `a:ax:${t.id}:d`) : btn('✅ تفعيل المشرف', `a:ax:${t.id}:e`)]);
  }
  rows.push([btn('⬅️ المشرفون', 'a:al'), ADMIN_HOME[0]]);
  return show(env, ctx, `<b>مشرف ${esc(t.telegram_id)}</b>\nالدور: ${esc(t.name_ar)}\nالحالة: ${t.status === 'active' ? 'فعّال ✅' : 'موقوف ⛔'}${manageable(ctx, t) ? '' : '\n(لا يمكنك تعديل هذا الحساب)'}`, rows);
}

async function rolePermsView(env, ctx, roleId) {
  if (!can(ctx, 'roles.manage')) return denied(env, ctx);
  const role = roleId === null ? null : await q.roleById(env.DB, roleId);
  if (!role || role.rank >= ctx.admin.rank) return denied(env, ctx);
  const [perms, has] = [await q.allPerms(env.DB), await q.rolePermIds(env.DB, role.id)];
  const rows = perms.map((p) => [btn(`${has.has(p.id) ? '✅' : '⬜'} ${p.description_ar}`, `a:rt:${role.id}:${p.id}:${has.has(p.id) ? 0 : 1}`)]);
  rows.push([btn('⬅️ الأدوار', 'a:rl'), ADMIN_HOME[0]]);
  return show(env, ctx, `<b>صلاحيات: ${esc(role.name_ar)}</b>\nاضغط على صلاحية لتفعيلها أو إلغائها. (صلاحية «تعديل الأدوار» محجوزة للمالك ولا تُمنح.)`, rows);
}

async function executeTransfer(env, ctx, targetId) {
  const db = env.DB;
  if (!isOwner(ctx)) return denied(env, ctx);
  const t = await q.adminById(db, targetId);
  if (!t || t.status !== 'active' || t.id === ctx.admin.id) return show(env, ctx, 'تعذّر نقل الملكية: المشرف غير موجود أو غير فعّال.', [ADMIN_HOME]);
  const [ownerRole, adminRole] = [await q.roleByCode(db, 'owner'), await q.roleByCode(db, 'admin')];
  try {
    await q.transferOwnership(db, ctx.admin.id, t.id, ownerRole.id, adminRole.id); // معاملة واحدة
  } catch (e) {
    console.error('transfer failed:', redact(e.message, env));
    return show(env, ctx, 'تعذّر نقل الملكية. لم يتغير شيء.', [ADMIN_HOME]);
  }
  await q.audit(db, ctx.admin.id, 'ownership.transfer', 'administrator', t.id, { from: ctx.admin.id, to: t.id });
  await tg(env, 'sendMessage', { chat_id: t.telegram_id, text: 'أصبحت الآن مالك المكتبة. أرسل /admin لفتح لوحة الإدارة.' }).catch(() => {});
  return show(env, ctx, `تم نقل ملكية المكتبة إلى ${esc(t.telegram_id)} ✅\nدورك الآن: مدير.`, [[btn('🏠 الرئيسية', 'home')]]);
}

async function fileAdminCard(env, ctx, id) {
  if (!can(ctx, 'files.view')) return denied(env, ctx);
  const f = id === null ? null : await q.adminFile(env.DB, id);
  if (!f) return gone(env, ctx, 'الملف غير موجود.');
  const rows = [];
  if (can(ctx, 'files.hide')) rows.push([f.status === 'published' ? btn('🙈 إخفاء', `a:fh:${f.id}`) : btn('👁 نشر', `a:fp:${f.id}`)]);
  if (can(ctx, 'files.edit')) {
    rows.push([btn('✏️ العنوان', `a:fe:${f.id}`), btn('📝 الوصف', `a:fo:${f.id}`)]);
    rows.push([btn('🔀 نقل لمادة أخرى', `a:fm:${f.id}`), btn('🏷 تغيير النوع', `a:fc:${f.id}`)]);
  }
  if (can(ctx, 'files.delete')) rows.push([btn('🗑 حذف', `a:fd:${f.id}`)]);
  rows.push([btn('⬅️ الملفات', 'a:fl:0'), ADMIN_HOME[0]]);
  return show(env, ctx,
    `<b>${esc(f.title)}</b>\nالمادة: ${esc(f.course_name)}\nنوع المحتوى: ${esc(f.category_name)}\nالحالة: ${f.status === 'published' ? 'منشور 🟢' : 'مخفي 🟡'}\nالحجم: ${fmtSize(f.size_bytes)}  |  ${esc(f.extension.toUpperCase())}\nالمعرّف: ${esc(f.public_id)}`, rows);
}

// ---------- تأكيد الرفع: الأرشفة ثم الحفظ ----------
const mediaOf = (m, kind) => m.document || m.audio || m.video || m.voice || (Array.isArray(m.photo) ? m.photo[m.photo.length - 1] : null) || null;

async function confirmUpload(env, ctx) {
  const db = env.DB;
  if (!can(ctx, 'files.create')) return denied(env, ctx);
  const st = await q.takeState(db, ctx.tgId, 'up_confirm'); // تُسحب الحالة مرة واحدة: يمنع تكرار الأرشفة عند تكرار الضغط
  if (!st) return gone(env, ctx, 'لا توجد عملية رفع جارية (ربما تم النشر بالفعل).');
  const d = JSON.parse(st.data);
  const archiveChat = env.ARCHIVE_CHANNEL_ID || (await q.getSetting(db, 'archive_chat_id', ''));
  const restore = () => q.setState(db, ctx.tgId, 'up_confirm', d);
  if (!archiveChat) {
    await restore();
    return show(env, ctx, 'قناة الأرشيف غير مضبوطة بعد. أعد توجيه منشور من القناة إلى البوت ثم اضغط «تأكيد».', [[btn('✅ تأكيد النشر', 'a:uok')], CANCEL_ROW]);
  }
  const [method, field] = SEND[d.media_kind] ?? SEND.document;
  let archived;
  try {
    archived = await tg(env, method, { chat_id: archiveChat, [field]: d.tg_file_id, caption: String(d.title).slice(0, 200) });
  } catch (e) {
    console.error('archive failed:', redact(e.message, env));
    await restore();
    return show(env, ctx, 'تعذّر الحفظ في قناة الأرشيف. تأكد أن البوت مشرف في القناة ثم أعد المحاولة.', [[btn('🔁 إعادة المحاولة', 'a:uok')], CANCEL_ROW]);
  }
  const m = mediaOf(archived, d.media_kind);
  const course = await q.courseInfo(db, d.course_id);
  try {
    const newId = await q.insertFile(db, {
      public_id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      course_id: d.course_id, category_id: d.category_id, title: d.title, description: d.description,
      search_text: `${d.title} ${d.description ?? ''} ${course?.name ?? ''}`.toLowerCase(),
      extension: d.extension, mime_type: d.mime_type, size_bytes: d.size_bytes, media_kind: d.media_kind,
      tg_file_id: m?.file_id ?? d.tg_file_id,
      tg_file_unique_id: m?.file_unique_id ?? d.tg_file_unique_id,
      archive_chat_id: Number(archiveChat), archive_message_id: archived.message_id, added_by: ctx.admin.id,
    });
    await q.audit(db, ctx.admin.id, 'file.create', 'file', newId, { title: d.title, course_id: d.course_id });
    return show(env, ctx, `تم نشر الملف <b>${esc(d.title)}</b> ✅`,
      [[btn('➕ ملف آخر في نفس المادة والنوع', `a:ut:${d.course_id}:${d.category_id}`)], [btn('➕ ملف في مادة أخرى', 'a:up')], ADMIN_HOME]);
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

// ---------- تحديد معدّل الاستخدام (يمنع الإزعاج دون كتابة في قاعدة البيانات) ----------
const hits = new Map();
function tooMany(userId, limit) {
  const now = Date.now();
  const e = hits.get(userId);
  if (!e || now - e.t > 10_000) {
    if (hits.size > 5000) hits.clear();
    hits.set(userId, { t: now, n: 1 });
    return false;
  }
  e.n += 1;
  return e.n > limit; // أكثر من 25 ضغطة/رسالة خلال 10 ثوانٍ (قابل للضبط)
}

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
  if (tooMany(from.id, Number(env.RATE_LIMIT) || 25)) return;

  try {
    const user = await q.touchUser(env.DB, from);
    if (!user || user.status === 'blocked') return;

    let admin = null;
    try { admin = await loadAdmin(env.DB, from.id); } catch (e) { console.error('admin lookup failed:', redact(e.message, env)); } // عند الفشل يُعامَل كطالب (آمن)
    const ctx = { chatId: chat.id, tgId: from.id, messageId: cb?.message?.message_id ?? null, user, admin };
    if (cb) {
      const data = String(cb.data ?? '');
      if (data.startsWith('a:')) { if (!(await adminCallback(env, ctx, data))) await notFound(env, ctx); }
      else await onCallback(env, ctx, data);
    } else if (!(ctx.admin && (await adminMessage(env, ctx, msg)))) await onMessage(env, ctx, msg);
  } catch (e) {
    console.error('handler error:', redact(e.message, env));
    await tg(env, 'sendMessage', { chat_id: chat.id, text: T.error }).catch(() => {});
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
      return show(env, ctx, await head(db, 'u', id, items.length ? T.chooseCollege : T.empty), listRows(items, 'd', 'u'));
    }
    case 'd': { // أقسام كلية
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.college(db, id);
      const items = await q.departments(db, id);
      return show(env, ctx, await head(db, 'c', id, items.length ? T.chooseDept : T.empty), listRows(items, 'l', p ? `c:${p.p}` : 'u'));
    }
    case 'l': { // مستويات قسم
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.department(db, id);
      const items = await q.levels(db, id);
      return show(env, ctx, await head(db, 'd', id, items.length ? T.chooseLevel : T.empty), listRows(items, 's', p ? `d:${p.p}` : 'u'));
    }
    case 's': { // فصول مستوى
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.level(db, id);
      const items = await q.semesters(db, id);
      return show(env, ctx, await head(db, 'l', id, items.length ? T.chooseSemester : T.empty), listRows(items, 'k', p ? `l:${p.p}` : 'u'));
    }
    case 'k': { // مواد فصل
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.semester(db, id);
      const items = (await q.courses(db, id)).map((c) => ({ id: c.id, label: `${c.name} (${c.files_count})` }));
      return show(env, ctx, await head(db, 's', id, items.length ? T.chooseCourse : T.empty), listRows(items, 'f', p ? `s:${p.p}` : 'u'));
    }
    case 'f': { // داخل المادة: أنواع المحتوى كأزرار
      if (id === null) return notFound(env, ctx);
      const p = await q.parentOf.course(db, id);
      const cats = await q.courseCategories(db, id);
      const rows = cats.map((c) => [btn(`${catIcon(c.name)} ${c.name} (${c.n})`, `t:${id}:${c.id}:0`)]);
      rows.push([btn('⬅️ رجوع', p ? `k:${p.p}` : 'u'), ...HOME]);
      return show(env, ctx, await head(db, 'k', id, cats.length ? 'اختر نوع المحتوى:' : T.empty), rows);
    }
    case 't': { // ملفات نوع محتوى داخل مادة: t:<course>:<category>:<page>
      const cat = parseId(b);
      if (id === null || cat === null) return notFound(env, ctx);
      const page = Math.min(parseId(data.split(':')[3]) ?? 0, 1000);
      const items = await q.filesOfCourse(db, id, cat, PAGE, page * PAGE);
      const label = items[0]?.category_name ? `${catIcon(items[0].category_name)} ${items[0].category_name}` : '';
      return show(env, ctx, await head(db, 'k', id, items.length ? `${label}\nاختر الملف:` : T.empty),
        pagedRows(items, `t:${id}:${cat}`, page, 'vb', `f:${id}`));
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

// رأس الرسالة: مسار التصنيف الحالي (جامعة › كلية › ...) ثم التعليمات
async function head(db, kind, id, text) {
  const c = await q.crumb(db, kind, id);
  return c ? `<b>${esc(c)}</b>\n${text}` : text;
}

async function fileCard(env, ctx, id, source) {
  if (id === null) return notFound(env, ctx);
  const f = await q.visibleFile(env.DB, id);
  if (!f) return notFound(env, ctx);
  const back = source === 'vn' ? 'new:0' : source === 'vt' ? 'top:0' : `t:${f.course_id}:${f.category_id}:0`;
  const lines = [
    `<b>${esc(f.title)}</b>`,
    `المادة: ${esc(f.course_name)}`,
    f.doctor_name ? `الدكتور: ${esc(f.doctor_name)}` : null,
    `المستوى: ${esc(f.level_name)}`,
    `نوع المحتوى: ${catIcon(f.category_name)} ${esc(f.category_name)}`,
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
    const [method, field] = SEND[f.media_kind] ?? SEND.document;
    await tg(env, method, { chat_id: ctx.chatId, [field]: f.tg_file_id, caption: String(f.title).slice(0, 200) });
  } catch (e) {
    console.error('send failed:', redact(e.message, env), 'file', f.id);
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
    if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM telegram_updates WHERE received_at < datetime('now', '-2 days')").run().catch(() => {}); // تنظيف دوري
    await handleUpdate(env, update);
  } catch (e) {
    console.error('update failed:', redact(e?.message, env));
    // محاولة أخيرة لإبلاغ المستخدم برسالة لطيفة (مثلًا عند تعطل قاعدة البيانات)
    const chat = update?.message?.chat ?? update?.callback_query?.message?.chat;
    if (chat?.type === 'private') await tg(env, 'sendMessage', { chat_id: chat.id, text: 'حدث خطأ مؤقت. حاول مرة أخرى بعد قليل.' }).catch(() => {});
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
      return Response.json({ ok: true, service: 'unilib', version: '0.4.0' });
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

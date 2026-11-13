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

export async function getSetting(db, key, fallback) {
  const r = await db.prepare('SELECT value FROM bot_settings WHERE key = ?').bind(key).first();
  return r ? r.value : fallback;
}

// يعيد false إذا كان التحديث مكررًا
export async function claimUpdate(db, updateId) {
  const r = await db.prepare('INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)').bind(updateId).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function touchUser(db, tgUser) {
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

export const universities = (db) =>
  list(db, 'SELECT id, name FROM universities WHERE is_active = 1 ORDER BY sort_order, name');
export const colleges = (db, id) =>
  list(db, 'SELECT id, name FROM colleges WHERE university_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
export const departments = (db, id) =>
  list(db, 'SELECT id, name FROM departments WHERE college_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
export const levels = (db, id) =>
  list(db, 'SELECT id, name FROM academic_levels WHERE department_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
export const semesters = (db, id) =>
  list(db, 'SELECT id, name FROM semesters WHERE level_id = ? AND is_active = 1 ORDER BY sort_order, name', id);
export const courses = (db, id) =>
  list(db,
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM files f WHERE f.course_id = c.id AND f.status = 'published') AS files_count
     FROM courses c WHERE c.semester_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.name`, id);

// الآباء (لأزرار الرجوع)
export const parentOf = {
  college: (db, id) => db.prepare('SELECT university_id AS p FROM colleges WHERE id = ?').bind(id).first(),
  department: (db, id) => db.prepare('SELECT college_id AS p FROM departments WHERE id = ?').bind(id).first(),
  level: (db, id) => db.prepare('SELECT department_id AS p FROM academic_levels WHERE id = ?').bind(id).first(),
  semester: (db, id) => db.prepare('SELECT level_id AS p FROM semesters WHERE id = ?').bind(id).first(),
  course: (db, id) => db.prepare('SELECT semester_id AS p FROM courses WHERE id = ?').bind(id).first(),
};

export const filesOfCourse = (db, courseId, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name ${VISIBLE_FILE_FROM} AND f.course_id = ?
            ORDER BY cat.sort_order, f.created_at DESC LIMIT ? OFFSET ?`, courseId, limit + 1, offset);

export const latestFiles = (db, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name ${VISIBLE_FILE_FROM}
            ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);

export const topFiles = (db, limit, offset) =>
  list(db, `SELECT f.id, f.title, f.extension, cat.name AS category_name,
              (SELECT COUNT(*) FROM downloads dl WHERE dl.file_id = f.id) AS dl_count
            ${VISIBLE_FILE_FROM} AND EXISTS (SELECT 1 FROM downloads x WHERE x.file_id = f.id)
            ORDER BY dl_count DESC, f.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);

export const visibleFile = (db, id) =>
  db.prepare(`SELECT ${FILE_COLS} ${VISIBLE_FILE_FROM} AND f.id = ?`).bind(id).first();

export const recordDownload = (db, fileId, userId) =>
  db.prepare('INSERT INTO downloads (file_id, user_id) VALUES (?, ?)').bind(fileId, userId).run();

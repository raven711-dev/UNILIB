-- UNILIB — الترحيل 0001: الهيكل الأساسي (متوافق مع Cloudflare D1 / SQLite)

-- ========== الصلاحيات والأدوار ==========
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code IN ('owner','admin','content_manager','viewer')),
  name_ar     TEXT NOT NULL,
  rank        INTEGER NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE permissions (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  description_ar TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE administrators (
  id           INTEGER PRIMARY KEY,
  telegram_id  INTEGER NOT NULL UNIQUE,
  display_name TEXT,
  role_id      INTEGER NOT NULL REFERENCES roles(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by   INTEGER REFERENCES administrators(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admins_role ON administrators(role_id);

CREATE TABLE admin_sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  admin_id     INTEGER NOT NULL REFERENCES administrators(id) ON DELETE CASCADE,
  csrf_hash    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_sessions_expiry ON admin_sessions(expires_at);

-- ========== المستخدمون (الطلاب) ==========
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  telegram_id   INTEGER NOT NULL UNIQUE,
  display_name  TEXT,
  username      TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_last_active ON users(last_active_at);
CREATE INDEX idx_users_first_seen ON users(first_seen_at);

-- ========== هيكل المكتبة ==========
CREATE TABLE universities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE colleges (
  id INTEGER PRIMARY KEY,
  university_id INTEGER NOT NULL REFERENCES universities(id),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (university_id, name)
);

CREATE TABLE departments (
  id INTEGER PRIMARY KEY,
  college_id INTEGER NOT NULL REFERENCES colleges(id),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (college_id, name)
);

CREATE TABLE academic_levels (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (department_id, name)
);

CREATE TABLE semesters (
  id INTEGER PRIMARY KEY,
  level_id INTEGER NOT NULL REFERENCES academic_levels(id),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (level_id, name)
);

CREATE TABLE doctors (
  id INTEGER PRIMARY KEY,
  university_id INTEGER NOT NULL REFERENCES universities(id),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (university_id, name)
);

CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  doctor_id INTEGER REFERENCES doctors(id),
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (semester_id, name)
);
CREATE INDEX idx_courses_doctor ON courses(doctor_id);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE allowed_file_types (
  extension TEXT PRIMARY KEY,
  mime_type TEXT,
  is_allowed INTEGER NOT NULL DEFAULT 1 CHECK (is_allowed IN (0,1)),
  max_size_bytes INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes > 0)
);

-- ========== الملفات ==========
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  keywords TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  extension TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  tg_file_id TEXT NOT NULL,
  tg_file_unique_id TEXT NOT NULL,
  archive_chat_id INTEGER NOT NULL,
  archive_message_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden','deleted')),
  added_by INTEGER NOT NULL REFERENCES administrators(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES administrators(id),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_files_unique_tg ON files(tg_file_unique_id) WHERE status <> 'deleted';
CREATE UNIQUE INDEX uq_files_archive_msg ON files(archive_chat_id, archive_message_id);
CREATE INDEX idx_files_course ON files(course_id, status);
CREATE INDEX idx_files_category ON files(category_id);
CREATE INDEX idx_files_latest ON files(status, created_at DESC);
CREATE INDEX idx_files_added_by ON files(added_by);

CREATE TABLE downloads (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_downloads_file ON downloads(file_id);
CREATE INDEX idx_downloads_user ON downloads(user_id);
CREATE INDEX idx_downloads_date ON downloads(created_at);

-- ========== الدعم والإعدادات والأمان ==========
CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','closed')),
  handled_by INTEGER REFERENCES administrators(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_support_status ON support_messages(status, created_at);

CREATE TABLE bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  is_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0,1)),
  updated_by INTEGER REFERENCES administrators(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_updates_received ON telegram_updates(received_at);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER REFERENCES administrators(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_time ON audit_logs(created_at);
CREATE INDEX idx_audit_admin ON audit_logs(admin_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER admins_owner_no_delete BEFORE DELETE ON administrators
WHEN OLD.role_id = (SELECT id FROM roles WHERE code='owner')
BEGIN SELECT RAISE(ABORT, 'owner cannot be deleted'); END;

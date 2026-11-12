"""اختبار قاعدة البيانات محليًا (SQLite). التشغيل: python3 tests/test_schema.py"""
import sqlite3, glob, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []
def check(name, cond):
    results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)

def fresh():
    db = sqlite3.connect(":memory:"); db.execute("PRAGMA foreign_keys=ON")
    for f in sorted(glob.glob(os.path.join(ROOT, "migrations", "*.sql"))):
        db.executescript(open(f, encoding="utf-8").read())
    return db

def raises(db, sql, params=()):
    try: db.execute(sql, params); return False
    except sqlite3.DatabaseError: return True

db = fresh()
check("المهاجرات تُطبَّق بدون أخطاء", True)
check("الأدوار الأربعة موجودة", db.execute("select count(*) from roles").fetchone()[0] == 4)

def perms(role):
    return {r[0] for r in db.execute("select p.code from role_permissions rp join permissions p on p.id=rp.permission_id join roles r on r.id=rp.role_id where r.code=?", (role,))}
allp = {r[0] for r in db.execute("select code from permissions")}
check("المالك يملك كل الصلاحيات", perms("owner") == allp)
check("المدير لا يدير المشرفين ولا الأدوار", not ({"admins.manage","roles.manage","settings.security","backup.import"} & perms("admin")))
check("المطّلع لا يملك أي صلاحية كتابة", perms("viewer") <= {"files.view","stats.view"})
check("مسؤول المحتوى لا يرى بيانات الطلاب", "students.view" not in perms("content_manager"))
check("أنواع الملفات الخطرة مرفوضة افتراضيًا",
      db.execute("select count(*) from allowed_file_types where extension in ('exe','apk','bat','sh','js','msi','scr') and is_allowed=1").fetchone()[0] == 0)

# بيانات تجريبية للمكتبة (محلية فقط)
db.execute("insert into administrators(id,telegram_id,display_name,role_id) values (1,111,'owner',1)")
db.execute("insert into universities(id,name) values (1,'جامعة تجريبية')")
db.execute("insert into colleges(id,university_id,name) values (1,1,'كلية')")
db.execute("insert into departments(id,college_id,name) values (1,1,'قسم')")
db.execute("insert into academic_levels(id,department_id,name) values (1,1,'المستوى الثاني')")
db.execute("insert into semesters(id,level_id,name) values (1,1,'الفصل الأول')")
db.execute("insert into courses(id,semester_id,name) values (1,1,'قواعد البيانات')")
FILE = "insert into files(public_id,course_id,category_id,title,extension,size_bytes,tg_file_id,tg_file_unique_id,archive_chat_id,archive_message_id,added_by,status,deleted_at) values (?,1,1,?,'pdf',1000,'fid',?,-100,?,1,?,?)"
db.execute(FILE, ("a1","محاضرة 1","u1",1,"published",None))
check("إضافة ملف صحيح", db.execute("select count(*) from files").fetchone()[0] == 1)

check("منع تكرار الملف (نفس unique_id)", raises(db, FILE, ("a2","نسخة","u1",2,"published",None)))
check("منع تكرار رسالة الأرشيف", raises(db, FILE, ("a3","x","u9",1,"published",None)))
check("حالة غير صالحة مرفوضة", raises(db, FILE, ("a4","x","u4",4,"weird",None)))
check("الحالة المحذوفة تتطلب deleted_at", raises(db, FILE, ("a5","x","u5",5,"deleted",None)))
db.execute("update files set status='deleted', deleted_at=datetime('now'), deleted_by=1 where public_id='a1'")
check("الحذف المنطقي يُبقي السجل", db.execute("select count(*) from files").fetchone()[0] == 1)
check("يمكن إعادة رفع ملف بعد حذفه منطقيًا", not raises(db, FILE, ("a6","محاضرة 1 جديدة","u1",6,"published",None)))

check("مفتاح خارجي: مادة بفصل غير موجود مرفوضة", raises(db, "insert into courses(semester_id,name) values (999,'x')"))
check("مفتاح خارجي: ملف بمشرف غير موجود مرفوض", raises(db, "insert into files(public_id,course_id,category_id,title,extension,size_bytes,tg_file_id,tg_file_unique_id,archive_chat_id,archive_message_id,added_by) values ('z',1,1,'t','pdf',1,'f','uz',-100,77,999)"))
check("حذف جامعة مرتبطة مرفوض", raises(db, "delete from universities where id=1"))

db.execute("insert into users(id,telegram_id) values (1,555)")
db.execute("insert into downloads(file_id,user_id) values (2,1)")
check("تسجيل تنزيل", db.execute("select count(*) from downloads").fetchone()[0] == 1)
check("منع تكرار telegram_id للطلاب", raises(db, "insert into users(telegram_id) values (555)"))
db.execute("insert into telegram_updates(update_id) values (42)")
check("منع تكرار معالجة تحديث Telegram", raises(db, "insert into telegram_updates(update_id) values (42)"))

db.execute("insert into audit_logs(admin_id,action,entity_type,entity_id) values (1,'file.create','file','a1')")
check("سجل العمليات: منع التعديل", raises(db, "update audit_logs set action='x'"))
check("سجل العمليات: منع الحذف", raises(db, "delete from audit_logs"))
check("منع حذف المالك", raises(db, "delete from administrators where id=1"))

# منع SQL injection: الاستعلام المُعَامَل يعامل المدخل كنص
evil = "x'; DROP TABLE files;--"
db.execute("select * from files where title = ?", (evil,)).fetchall()
check("الاستعلام المُعامَل لا ينفّذ حقنًا", db.execute("select count(*) from files").fetchone()[0] == 2)

def plan(sql, p=()):
    return " ".join(r[3] for r in db.execute("explain query plan "+sql, p))
check("أحدث الملفات تستخدم فهرسًا", "idx_files_latest" in plan("select * from files where status='published' order by created_at desc limit 8"))
check("عدد تنزيلات ملف يستخدم فهرسًا", "idx_downloads_file" in plan("select count(*) from downloads where file_id=?", (1,)))
check("ملفات المادة تستخدم فهرسًا", "idx_files_course" in plan("select * from files where course_id=? and status='published'", (1,)))

ok = all(r[1] for r in results)
print(f"\n{sum(r[1] for r in results)}/{len(results)} passed")
sys.exit(0 if ok else 1)

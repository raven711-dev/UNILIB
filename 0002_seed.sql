-- بيانات أولية بدون أي أسرار
INSERT INTO roles (id, code, name_ar, rank) VALUES
 (1,'owner','المالك',100),(2,'admin','المدير',80),
 (3,'content_manager','مسؤول المحتوى',50),(4,'viewer','المشرف المطّلع',10);

INSERT INTO permissions (id, code, description_ar) VALUES
 (1,'files.view','عرض الملفات'),
 (2,'files.create','رفع الملفات'),
 (3,'files.edit','تعديل بيانات الملفات'),
 (4,'files.hide','إخفاء الملفات'),
 (5,'files.delete','الحذف المنطقي للملفات'),
 (6,'catalog.manage','إدارة الجامعات والكليات والأقسام والمواد'),
 (7,'categories.manage','إدارة أنواع المحتوى'),
 (8,'students.view','عرض بيانات الطلاب'),
 (9,'stats.view','عرض الإحصائيات'),
 (10,'audit.view','عرض سجل العمليات'),
 (11,'admins.manage','إدارة المشرفين'),
 (12,'roles.manage','تعديل الأدوار والصلاحيات'),
 (13,'settings.edit','تعديل الإعدادات'),
 (14,'settings.security','تعديل الإعدادات الأمنية'),
 (15,'backup.export','تصدير النسخ الاحتياطي'),
 (16,'backup.import','استيراد النسخ الاحتياطي'),
 (17,'support.manage','الرد على رسائل الدعم');

INSERT INTO role_permissions SELECT 1, id FROM permissions;
INSERT INTO role_permissions SELECT 2, id FROM permissions
 WHERE code NOT IN ('admins.manage','roles.manage','settings.security','backup.import');
INSERT INTO role_permissions SELECT 3, id FROM permissions
 WHERE code IN ('files.view','files.create','files.edit','files.hide','categories.manage','stats.view','support.manage');
INSERT INTO role_permissions SELECT 4, id FROM permissions
 WHERE code IN ('files.view','stats.view');

INSERT INTO categories (name, sort_order) VALUES
 ('محاضرات',1),('ملخصات',2),('اختبارات سابقة',3),('تمارين وواجبات',4),('مراجع',5);

INSERT INTO allowed_file_types (extension, mime_type, is_allowed) VALUES
 ('pdf','application/pdf',1),('doc','application/msword',1),
 ('docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',1),
 ('ppt','application/vnd.ms-powerpoint',1),
 ('pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',1),
 ('xls','application/vnd.ms-excel',1),
 ('xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',1),
 ('txt','text/plain',1),('jpg','image/jpeg',1),('jpeg','image/jpeg',1),('png','image/png',1),
 ('zip','application/zip',0),
 ('exe',NULL,0),('apk',NULL,0),('bat',NULL,0),('sh',NULL,0),('js',NULL,0),('msi',NULL,0),('scr',NULL,0);

INSERT INTO bot_settings (key, value) VALUES
 ('library_name','UNILIB — المكتبة الجامعية الرقمية'),
 ('welcome_message','مرحبًا بك في المكتبة الجامعية الرقمية. اختر من القائمة للبدء.'),
 ('page_size','8'),
 ('max_file_size_bytes','20971520'),
 ('support_rate_per_hour','3'),
 ('audit_retention_days','365');

-- P0 数据生命周期修复：用户删除时同步清理访问记录
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_user_id_fkey;
ALTER TABLE visits ADD CONSTRAINT visits_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE;

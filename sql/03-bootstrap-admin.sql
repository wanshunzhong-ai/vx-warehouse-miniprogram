-- =============================================================================
-- 内部仓库物品管理 · 创建第一个管理员账号（引导脚本）
-- -----------------------------------------------------------------------------
-- 前置：先执行 01-schema.sql → 02-functions.sql
--
-- 为什么需要这一步？
--   员工不能自己注册（这是刻意的）：主管添加 → 管理员审批 → 才能登录。
--   所以第一个管理员只能由你在数据库里手动种进去，之后一切都在小程序里完成。
--
-- 执行方法：把下面 DO 块里的 c_password 改成你自己的密码，然后整段执行一次。
--   · WorkBuddy 云服务：在云服务数据库控制台执行，或让 WorkBuddy 代执行
--   · 自建 / Supabase：用 SQL Editor 或 psql 执行
--
-- 改完之后这个文件里仍然是占位密码 —— 不要把真实密码写回文件（仓库是公开的）。
-- =============================================================================

DO $bootstrap$
DECLARE
  -- ↓↓↓ 只需要改这一行：改成你自己的初始密码（至少 6 位，建议 12 位以上）
  c_password constant text := 'ChangeMe@2026';
  c_username constant text := 'admin';
  c_name     constant text := '系统管理员';
  c_dept     constant text := '信息部';
BEGIN
  IF length(c_password) < 6 THEN
    RAISE EXCEPTION '初始密码至少 6 位';
  END IF;
  IF c_password = 'ChangeMe@2026' THEN
    RAISE EXCEPTION '请先把 c_password 改成你自己的密码，再执行本脚本';
  END IF;

  IF EXISTS (SELECT 1 FROM public.staff WHERE lower(username) = lower(c_username)) THEN
    RAISE NOTICE '账号 % 已存在，跳过（想重置请到小程序「人员管理」里操作）', c_username;
    RETURN;
  END IF;

  INSERT INTO public.staff (username, password_hash, name, dept, role, status, must_change_password, created_by_name)
  VALUES (
    lower(c_username),
    crypt(c_password, gen_salt('bf', 8)),
    c_name,
    c_dept,
    'admin',
    'active',
    true,          -- 首次登录会被要求立刻改成新密码（安全默认）
    'bootstrap'
  );

  RAISE NOTICE '已创建管理员：% / %（首次登录会要求修改密码）', c_username, c_password;
END
$bootstrap$;

-- 校验：应能看到一行 admin / active
-- SELECT id, username, name, role, status, must_change_password FROM public.staff ORDER BY id;

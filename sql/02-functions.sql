-- =============================================================================
-- 内部仓库物品管理 · 服务端函数（全部业务逻辑与权限边界）
-- -----------------------------------------------------------------------------
-- 前置：先执行 01-schema.sql
-- 执行顺序：01-schema.sql → 02-functions.sql → 03-bootstrap-admin.sql
--
-- 为什么业务逻辑都放在数据库函数里？
--   小程序客户端能被反编译、接口能被直接调用。把"谁有权做什么"写进
--   带 SECURITY DEFINER 的数据库函数，客户端绕过界面直接调接口也拿不到越权数据。
--
-- 约定（与 01-schema.sql 的权限模型配套）：
--   · 除少数几个裸函数外，全部 SECURITY DEFINER —— 以函数属主身份执行，
--     因此 staff / staff_sessions / stock_records 不需要给客户端任何表级权限。
--   · 每次调用都带 p_token，函数内先 staff_auth() 校验会话，再判断角色。
--   · 库存**只能**通过 stock_change() 改：内部 SELECT ... FOR UPDATE 行锁 + 写流水。
--   · 角色层级 admin(3) > manager(2) > staff(1)，用 staff_rank() 比较。
-- =============================================================================


-- =============================================================================
-- 一、基础辅助函数
-- =============================================================================

-- 角色等级，用于"至少主管"这类比较
CREATE OR REPLACE FUNCTION public.staff_rank(p_role text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT CASE p_role WHEN 'admin' THEN 3 WHEN 'manager' THEN 2 WHEN 'staff' THEN 1 ELSE 0 END $function$;

-- 随机初始密码（8 位，去掉了容易看错的 0/O/1/l/I 等字符）
CREATE OR REPLACE FUNCTION public.staff_random_password()
 RETURNS text
 LANGUAGE plpgsql
AS $function$ DECLARE c_alpha constant text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_out text := ''; v_i integer; BEGIN FOR v_i IN 1..8 LOOP v_out := v_out || substr(c_alpha, 1 + floor(random() * length(c_alpha))::integer, 1); END LOOP; RETURN v_out; END $function$;

-- 账号对外字段白名单：password_hash 永远不出现在返回值里
CREATE OR REPLACE FUNCTION public.staff_public_json(v staff)
 RETURNS json
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT json_build_object('id', v.id, 'username', v.username, 'name', v.name, 'phone', v.phone, 'dept', v.dept, 'role', v.role, 'status', v.status, 'must_change_password', v.must_change_password, 'remark', v.remark, 'created_by_name', v.created_by_name, 'reviewed_by_name', v.reviewed_by_name, 'reviewed_at', v.reviewed_at, 'review_note', v.review_note, 'last_login_at', v.last_login_at, 'login_count', v.login_count, 'created_at', v.created_at) $function$;

-- 建议编号 WP0001（建档页"换个编号"用；无副作用）
CREATE OR REPLACE FUNCTION public.next_item_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$ DECLARE v_next bigint; BEGIN SELECT GREATEST(nextval('item_code_seq'), COALESCE(MAX(CASE WHEN code ~ '^WP[0-9]+$' THEN substring(code from 3)::bigint END), 0) + 1) INTO v_next FROM items; RETURN 'WP' || LPAD(v_next::text, 4, '0'); END $function$;

-- 库存预警：**必须带 min_qty > 0**。
-- 逐件赋码的物品安全库存恒为 0，领用出去后 qty 也是 0，
-- 只判 qty <= min_qty 会把"已被领走"读成"库存告急"，预警列表会被刷屏。
-- 口径必须与 staff_stats.low_count、客户端 utils/util.js 的 decorateItem.isLow 一致。
CREATE OR REPLACE FUNCTION public.low_stock_items(p_limit integer DEFAULT 20)
 RETURNS SETOF items
 LANGUAGE sql
 STABLE
AS $function$
  SELECT * FROM items
   WHERE status = 'active'
     AND min_qty > 0
     AND qty <= min_qty
   ORDER BY (qty - min_qty) ASC, name ASC
   LIMIT p_limit
$function$;


-- =============================================================================
-- 二、会话与鉴权
-- =============================================================================

-- 令牌 → 账号。所有需要身份的函数的入口。
CREATE OR REPLACE FUNCTION public.staff_auth(p_token text)
 RETURNS staff
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v staff%ROWTYPE; BEGIN IF p_token IS NULL OR length(btrim(p_token)) < 16 THEN RAISE EXCEPTION 'NOT_SIGNED_IN'; END IF; SELECT s.* INTO v FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id WHERE ss.token = btrim(p_token) AND ss.expires_at > now(); IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_EXPIRED'; END IF; IF v.status <> 'active' THEN RAISE EXCEPTION 'ACCOUNT_DISABLED'; END IF; UPDATE staff_sessions SET last_seen_at = now() WHERE token = btrim(p_token) AND last_seen_at < now() - interval '5 minutes'; RETURN v; END $function$;

-- 令牌 + 最低角色。用于"仅主管及以上"这类接口的第一行。
CREATE OR REPLACE FUNCTION public.staff_require(p_token text, p_min_role text)
 RETURNS staff
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v staff%ROWTYPE; BEGIN v := staff_auth(p_token); IF staff_rank(v.role) < staff_rank(p_min_role) THEN RAISE EXCEPTION 'NO_PERMISSION'; END IF; RETURN v; END $function$;

-- 登录：用户名不区分大小写；失败也跑一次 hash 比较（诱饵），避免按响应时间枚举账号
CREATE OR REPLACE FUNCTION public.staff_login(p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v staff%ROWTYPE; v_token text; v_exp timestamptz; c_decoy constant text := '$2a$08$qDOaU9epuLfyB/KbeOcRk.w5Z0YA0RjGUwgvRRT1W3tfa88eaQy/y'; BEGIN IF p_username IS NULL OR btrim(p_username) = '' OR p_password IS NULL OR p_password = '' THEN RAISE EXCEPTION 'INVALID_CREDENTIALS'; END IF; SELECT * INTO v FROM staff WHERE lower(username) = lower(btrim(p_username)); IF NOT FOUND THEN PERFORM crypt(p_password, c_decoy); RAISE EXCEPTION 'INVALID_CREDENTIALS'; END IF; IF v.password_hash <> crypt(p_password, v.password_hash) THEN RAISE EXCEPTION 'INVALID_CREDENTIALS'; END IF; IF v.status = 'pending' THEN RAISE EXCEPTION 'ACCOUNT_PENDING'; END IF; IF v.status = 'rejected' THEN RAISE EXCEPTION 'ACCOUNT_REJECTED'; END IF; IF v.status = 'disabled' THEN RAISE EXCEPTION 'ACCOUNT_DISABLED'; END IF; v_token := encode(gen_random_bytes(24), 'hex'); v_exp := now() + interval '30 days'; INSERT INTO staff_sessions (token, staff_id, expires_at) VALUES (v_token, v.id, v_exp); DELETE FROM staff_sessions WHERE expires_at < now(); UPDATE staff SET last_login_at = now(), login_count = login_count + 1 WHERE id = v.id; RETURN json_build_object('token', v_token, 'expires_at', v_exp, 'staff', staff_public_json(v)); END $function$;

-- 退出登录：删掉这条会话
CREATE OR REPLACE FUNCTION public.staff_logout(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN DELETE FROM staff_sessions WHERE token = btrim(COALESCE(p_token, '')); RETURN json_build_object('ok', true); END $function$;

-- 取当前登录人资料
CREATE OR REPLACE FUNCTION public.staff_me(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v staff%ROWTYPE; BEGIN v := staff_auth(p_token); RETURN staff_public_json(v); END $function$;

-- 修改自己的密码：改完踢掉其它设备的会话
CREATE OR REPLACE FUNCTION public.staff_change_password(p_token text, p_old text, p_new text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v staff%ROWTYPE; BEGIN v := staff_auth(p_token); IF p_new IS NULL OR length(btrim(p_new)) < 6 THEN RAISE EXCEPTION 'PASSWORD_TOO_SHORT'; END IF; IF v.password_hash <> crypt(COALESCE(p_old, ''), v.password_hash) THEN RAISE EXCEPTION 'OLD_PASSWORD_WRONG'; END IF; UPDATE staff SET password_hash = crypt(btrim(p_new), gen_salt('bf', 8)), must_change_password = false, updated_at = now() WHERE id = v.id; DELETE FROM staff_sessions WHERE staff_id = v.id AND token <> btrim(p_token); RETURN json_build_object('ok', true); END $function$;

-- 改自己的资料（姓名 / 电话 / 部门），改不了角色与状态
CREATE OR REPLACE FUNCTION public.staff_update_profile(p_token text, p_name text, p_phone text, p_dept text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v staff%ROWTYPE; BEGIN v := staff_auth(p_token); IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF; UPDATE staff SET name = btrim(p_name), phone = NULLIF(btrim(COALESCE(p_phone, '')), ''), dept = NULLIF(btrim(COALESCE(p_dept, '')), ''), updated_at = now() WHERE id = v.id; SELECT * INTO v FROM staff WHERE id = v.id; RETURN staff_public_json(v); END $function$;


-- =============================================================================
-- 三、人员管理（主管及以上，管理员看全部 / 主管只看自己提交的）
-- =============================================================================

-- 人员列表。关键：主管的可见范围被限制在 created_by_id = 自己。
-- 另外返回 is_mine，客户端靠它区分"是不是我提交的"，不用再查一次。
CREATE OR REPLACE FUNCTION public.staff_list(p_token text, p_status text, p_role text, p_keyword text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_out json; v_kw text; BEGIN v_me := staff_require(p_token, 'manager'); v_kw := NULLIF(btrim(COALESCE(p_keyword, '')), ''); SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_out FROM ( SELECT id, username, name, phone, dept, role, status, remark, review_note, created_by_id, created_by_name, reviewed_by_name, reviewed_at, last_login_at, login_count, created_at, (created_by_id = v_me.id) AS is_mine FROM staff WHERE (v_me.role = 'admin' OR created_by_id = v_me.id) AND (COALESCE(btrim(COALESCE(p_status, '')), '') IN ('', 'all') OR status = btrim(p_status)) AND (COALESCE(btrim(COALESCE(p_role, '')), '') IN ('', 'all') OR role = btrim(p_role)) AND (v_kw IS NULL OR username ILIKE '%' || v_kw || '%' OR name ILIKE '%' || v_kw || '%' OR COALESCE(phone, '') ILIKE '%' || v_kw || '%') ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'disabled' THEN 2 ELSE 3 END, created_at DESC ) t; RETURN v_out; END $function$;

-- 人员概览（首页卡片）
CREATE OR REPLACE FUNCTION public.staff_overview(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_out json; BEGIN v_me := staff_require(p_token, 'manager'); SELECT json_build_object('admin', (SELECT count(*) FROM staff WHERE role = 'admin' AND status = 'active'), 'manager', (SELECT count(*) FROM staff WHERE role = 'manager' AND status = 'active'), 'staff', (SELECT count(*) FROM staff WHERE role = 'staff' AND status = 'active'), 'active_total', (SELECT count(*) FROM staff WHERE status = 'active'), 'pending', (SELECT count(*) FROM staff WHERE status = 'pending'), 'disabled', (SELECT count(*) FROM staff WHERE status = 'disabled'), 'rejected', (SELECT count(*) FROM staff WHERE status = 'rejected'), 'my_total', (SELECT count(*) FROM staff WHERE created_by_id = v_me.id), 'my_active', (SELECT count(*) FROM staff WHERE created_by_id = v_me.id AND status = 'active'), 'my_pending', (SELECT count(*) FROM staff WHERE created_by_id = v_me.id AND status = 'pending'), 'my_rejected', (SELECT count(*) FROM staff WHERE created_by_id = v_me.id AND status = 'rejected')) INTO v_out; RETURN v_out; END $function$;

-- 添加账号。管理员创建 → 直接 active；主管创建 → pending，等管理员审批。
-- 不传密码则服务端随机生成并返回一次。
CREATE OR REPLACE FUNCTION public.staff_create(p_token text, p_username text, p_name text, p_role text, p_phone text, p_dept text, p_remark text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_role text; v_status text; v_pwd text; v_auto boolean; v_new staff%ROWTYPE; v_dup integer; BEGIN v_me := staff_require(p_token, 'manager'); IF p_username IS NULL OR btrim(p_username) = '' THEN RAISE EXCEPTION 'USERNAME_REQUIRED'; END IF; IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF; IF btrim(p_username) !~ '^[A-Za-z0-9_.-]{3,24}$' THEN RAISE EXCEPTION 'USERNAME_INVALID'; END IF; SELECT count(*) INTO v_dup FROM staff WHERE lower(username) = lower(btrim(p_username)); IF v_dup > 0 THEN RAISE EXCEPTION 'USERNAME_TAKEN'; END IF; IF v_me.role = 'admin' THEN v_role := CASE WHEN p_role IN ('admin','manager','staff') THEN p_role ELSE 'staff' END; v_status := 'active'; ELSE v_role := 'staff'; v_status := 'pending'; END IF; v_auto := (NULLIF(btrim(COALESCE(p_password, '')), '') IS NULL); IF v_auto THEN v_pwd := staff_random_password(); ELSE v_pwd := btrim(p_password); END IF; IF length(v_pwd) < 6 THEN RAISE EXCEPTION 'PASSWORD_TOO_SHORT'; END IF; INSERT INTO staff (username, password_hash, name, phone, dept, role, status, remark, created_by_id, created_by_name, must_change_password) VALUES (lower(btrim(p_username)), crypt(v_pwd, gen_salt('bf', 8)), btrim(p_name), NULLIF(btrim(COALESCE(p_phone, '')), ''), NULLIF(btrim(COALESCE(p_dept, '')), ''), v_role, v_status, NULLIF(btrim(COALESCE(p_remark, '')), ''), v_me.id, v_me.name, true) RETURNING * INTO v_new; RETURN json_build_object('staff', staff_public_json(v_new), 'initial_password', CASE WHEN v_auto THEN v_pwd ELSE NULL END, 'need_review', v_status = 'pending'); END $function$;

-- 审批（仅管理员）。通过时可选升为主管。
CREATE OR REPLACE FUNCTION public.staff_review(p_token text, p_staff_id bigint, p_approve boolean, p_role text, p_note text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_t staff%ROWTYPE; BEGIN v_me := staff_require(p_token, 'admin'); SELECT * INTO v_t FROM staff WHERE id = p_staff_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_NOT_FOUND'; END IF; IF v_t.id = v_me.id THEN RAISE EXCEPTION 'CANNOT_REVIEW_SELF'; END IF; IF v_t.status <> 'pending' THEN RAISE EXCEPTION 'NOT_PENDING'; END IF; IF p_approve THEN UPDATE staff SET status = 'active', role = CASE WHEN p_role IN ('admin','manager','staff') THEN p_role ELSE v_t.role END, reviewed_by_id = v_me.id, reviewed_by_name = v_me.name, reviewed_at = now(), review_note = NULLIF(btrim(COALESCE(p_note, '')), ''), updated_at = now() WHERE id = v_t.id RETURNING * INTO v_t; ELSE UPDATE staff SET status = 'rejected', reviewed_by_id = v_me.id, reviewed_by_name = v_me.name, reviewed_at = now(), review_note = NULLIF(btrim(COALESCE(p_note, '')), ''), updated_at = now() WHERE id = v_t.id RETURNING * INTO v_t; END IF; RETURN staff_public_json(v_t); END $function$;

-- 改账号资料 / 角色 / 启停。
-- 主管的权限被三层收紧（改这里的任何一条都要先想清楚）：
--   ① 只能管 created_by_id = 自己 且 role = 'staff' 的人（否则 NOT_YOUR_STAFF）
--   ② 不能改角色（否则 ROLE_LOCKED）
--   ③ 只能在 active / disabled 之间切换 —— 见下方 NEED_REVIEW，堵的是
--      "主管把已被管理员驳回的账号改回启用"这条绕过审批的路
CREATE OR REPLACE FUNCTION public.staff_update(p_token text, p_staff_id bigint, p_name text, p_phone text, p_dept text, p_role text, p_status text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me staff%ROWTYPE;
  v_t staff%ROWTYPE;
  v_role text;
  v_status text;
  v_n integer;
  v_is_admin boolean;
BEGIN
  v_me := staff_require(p_token, 'manager');
  v_is_admin := (v_me.role = 'admin');
  SELECT * INTO v_t FROM staff WHERE id = p_staff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_NOT_FOUND'; END IF;

  IF NOT v_is_admin THEN
    IF v_t.created_by_id IS DISTINCT FROM v_me.id OR v_t.role <> 'staff' THEN
      RAISE EXCEPTION 'NOT_YOUR_STAFF';
    END IF;
  END IF;

  IF v_t.status = 'pending' THEN RAISE EXCEPTION 'NEED_REVIEW'; END IF;

  -- 主管只能在 active / disabled 之间切换：
  -- 否则主管把「已驳回」的员工改回启用，就等于自己绕过了管理员审批
  IF NOT v_is_admin AND v_t.status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'NEED_REVIEW';
  END IF;

  IF v_is_admin THEN
    v_role := CASE WHEN p_role IN ('admin','manager','staff') THEN p_role ELSE v_t.role END;
  ELSE
    IF NULLIF(btrim(COALESCE(p_role, '')), '') IS NOT NULL AND btrim(p_role) <> v_t.role THEN
      RAISE EXCEPTION 'ROLE_LOCKED';
    END IF;
    v_role := v_t.role;
  END IF;

  v_status := CASE WHEN p_status IN ('active','disabled') THEN p_status ELSE v_t.status END;

  IF v_t.id = v_me.id AND (v_role <> v_me.role OR v_status <> 'active') THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_SELF';
  END IF;
  IF v_t.role = 'admin' AND (v_role <> 'admin' OR v_status = 'disabled') THEN
    SELECT count(*) INTO v_n FROM staff WHERE role = 'admin' AND status = 'active' AND id <> v_t.id;
    IF v_n = 0 THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
  END IF;

  UPDATE staff SET name = COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), name),
                   phone = NULLIF(btrim(COALESCE(p_phone, '')), ''),
                   dept = NULLIF(btrim(COALESCE(p_dept, '')), ''),
                   role = v_role, status = v_status, updated_at = now()
  WHERE id = v_t.id RETURNING * INTO v_t;
  IF v_status = 'disabled' THEN DELETE FROM staff_sessions WHERE staff_id = v_t.id; END IF;
  RETURN staff_public_json(v_t);
END
$function$;

-- 重置密码（主管及以上；主管同样只能重置自己提交的员工）。
-- 重置后必须改密，且立刻踢掉该账号已有会话。
CREATE OR REPLACE FUNCTION public.staff_reset_password(p_token text, p_staff_id bigint, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me staff%ROWTYPE;
  v_t staff%ROWTYPE;
  v_pwd text;
  v_auto boolean;
BEGIN
  v_me := staff_require(p_token, 'manager');
  SELECT * INTO v_t FROM staff WHERE id = p_staff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_NOT_FOUND'; END IF;
  -- 主管只能重置自己提交的员工（管理员不限）
  IF v_me.role <> 'admin' THEN
    IF v_t.created_by_id IS DISTINCT FROM v_me.id OR v_t.role <> 'staff' THEN
      RAISE EXCEPTION 'NOT_YOUR_STAFF';
    END IF;
  END IF;
  v_auto := (NULLIF(btrim(COALESCE(p_password, '')), '') IS NULL);
  IF v_auto THEN v_pwd := staff_random_password(); ELSE v_pwd := btrim(p_password); END IF;
  IF length(v_pwd) < 6 THEN RAISE EXCEPTION 'PASSWORD_TOO_SHORT'; END IF;
  UPDATE staff SET password_hash = crypt(v_pwd, gen_salt('bf', 8)), must_change_password = true, updated_at = now() WHERE id = v_t.id;
  DELETE FROM staff_sessions WHERE staff_id = v_t.id;
  RETURN json_build_object('ok', true, 'password', CASE WHEN v_auto THEN v_pwd ELSE NULL END, 'name', v_t.name, 'username', v_t.username);
END
$function$;

-- 删除账号（仅管理员）。不能删自己；不能删掉最后一名管理员。
CREATE OR REPLACE FUNCTION public.staff_delete_account(p_token text, p_staff_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_t staff%ROWTYPE; v_n integer; BEGIN v_me := staff_require(p_token, 'admin'); SELECT * INTO v_t FROM staff WHERE id = p_staff_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_NOT_FOUND'; END IF; IF v_t.id = v_me.id THEN RAISE EXCEPTION 'CANNOT_DELETE_SELF'; END IF; IF v_t.role = 'admin' THEN SELECT count(*) INTO v_n FROM staff WHERE role = 'admin' AND id <> v_t.id; IF v_n = 0 THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF; END IF; DELETE FROM staff_sessions WHERE staff_id = v_t.id; DELETE FROM staff WHERE id = v_t.id; RETURN json_build_object('ok', true, 'name', v_t.name, 'username', v_t.username); END $function$;

-- 导出流水（主管及以上）。上限 5000 条，防止一次拉爆内存。
CREATE OR REPLACE FUNCTION public.staff_export_records(p_token text, p_limit integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_out json; BEGIN v_me := staff_require(p_token, 'manager'); SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO v_out FROM ( SELECT id, item_code, item_name, type, qty, before_qty, after_qty, COALESCE(staff_name, owner_name) AS operator_name, staff_role AS operator_role, note, created_at FROM stock_records ORDER BY created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000) ) t; RETURN v_out; END $function$;


-- =============================================================================
-- 四、统计与流水
-- =============================================================================

-- 出入库流水（分页）。scope = 'mine' 时只看自己的。
CREATE OR REPLACE FUNCTION public.staff_list_records(p_token text, p_item_code text, p_type text, p_today_only boolean, p_page integer, p_page_size integer, p_scope text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_out json; v_size integer; v_page integer; v_mine boolean; BEGIN v_me := staff_auth(p_token); v_size := LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 200); v_page := GREATEST(COALESCE(p_page, 1), 1); v_mine := (COALESCE(p_scope, 'all') = 'mine'); WITH f AS ( SELECT r.id, r.item_id, r.item_code, r.item_name, r.type, r.qty, r.before_qty, r.after_qty, COALESCE(r.staff_name, r.owner_name) AS operator_name, r.staff_role AS operator_role, (COALESCE(r.staff_id, 0) = v_me.id) AS is_mine, r.note, r.created_at FROM stock_records r WHERE (NOT v_mine OR r.staff_id = v_me.id) AND (COALESCE(btrim(COALESCE(p_item_code, '')), '') = '' OR r.item_code = btrim(p_item_code)) AND (COALESCE(btrim(COALESCE(p_type, '')), '') IN ('', 'all') OR r.type = btrim(p_type)) AND (NOT COALESCE(p_today_only, false) OR r.created_at >= date_trunc('day', now())) ) SELECT json_build_object('total', (SELECT count(*) FROM f), 'sum_in', (SELECT COALESCE(sum(qty), 0) FROM f WHERE type = 'in'), 'sum_out', (SELECT COALESCE(sum(qty), 0) FROM f WHERE type = 'out'), 'list', COALESCE((SELECT json_agg(row_to_json(g)) FROM (SELECT * FROM f ORDER BY created_at DESC LIMIT v_size OFFSET (v_page - 1) * v_size) g), '[]'::json)) INTO v_out; RETURN v_out; END $function$;

-- 仓库统计。low_count 的口径必须与 low_stock_items 一致（min_qty > 0）。
CREATE OR REPLACE FUNCTION public.staff_stats(p_token text, p_scope text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_me staff%ROWTYPE; v_out json; v_mine boolean;
BEGIN
  v_me := staff_auth(p_token);
  v_mine := (COALESCE(p_scope, 'all') = 'mine');
  SELECT json_build_object(
    'item_count', (SELECT count(*) FROM items WHERE status = 'active'),
    'total_qty', (SELECT COALESCE(sum(qty), 0) FROM items WHERE status = 'active'),
    'low_count', (SELECT count(*) FROM items WHERE status = 'active' AND min_qty > 0 AND qty <= min_qty),
    'today_in', (SELECT COALESCE(sum(qty), 0) FROM stock_records WHERE type = 'in' AND created_at >= date_trunc('day', now()) AND (NOT v_mine OR staff_id = v_me.id)),
    'today_out', (SELECT COALESCE(sum(qty), 0) FROM stock_records WHERE type = 'out' AND created_at >= date_trunc('day', now()) AND (NOT v_mine OR staff_id = v_me.id)),
    'today_count', (SELECT count(*) FROM stock_records WHERE created_at >= date_trunc('day', now()) AND (NOT v_mine OR staff_id = v_me.id)),
    'all_in', (SELECT COALESCE(sum(qty), 0) FROM stock_records WHERE type = 'in' AND (NOT v_mine OR staff_id = v_me.id)),
    'all_out', (SELECT COALESCE(sum(qty), 0) FROM stock_records WHERE type = 'out' AND (NOT v_mine OR staff_id = v_me.id)),
    'my_today_in', (SELECT COALESCE(sum(qty), 0) FROM stock_records WHERE type = 'in' AND staff_id = v_me.id AND created_at >= date_trunc('day', now())),
    'my_today_out', (SELECT COALESCE(sum(qty), 0) FROM stock_records WHERE type = 'out' AND staff_id = v_me.id AND created_at >= date_trunc('day', now())),
    'my_today_count', (SELECT count(*) FROM stock_records WHERE staff_id = v_me.id AND created_at >= date_trunc('day', now())),
    'my_total_count', (SELECT count(*) FROM stock_records WHERE staff_id = v_me.id)
  ) INTO v_out;
  RETURN v_out;
END $function$;


-- =============================================================================
-- 五、物品档案（建档 / 改档 / 导入 / 停用 / 删除）
-- =============================================================================

-- 建档或改档（同一个接口，p_id 为空表示新建）。
-- 物品名缺失抛 ITEM_NAME_REQUIRED —— 与账号类的 NAME_REQUIRED（姓名）分开，
-- 否则客户端错误文案会串味。
CREATE OR REPLACE FUNCTION public.staff_save_item(p_token text, p_id bigint, p_code text, p_name text, p_spec text, p_category text, p_unit text, p_location text, p_note text, p_min_qty integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_me staff%ROWTYPE; v_item items%ROWTYPE; v_code text; v_dup integer;
BEGIN
  v_me := staff_require(p_token, 'manager');
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'ITEM_NAME_REQUIRED'; END IF;
  IF p_id IS NOT NULL AND p_id > 0 THEN
    UPDATE items SET name = btrim(p_name), spec = NULLIF(btrim(COALESCE(p_spec, '')), ''), category = NULLIF(btrim(COALESCE(p_category, '')), ''), unit = COALESCE(NULLIF(btrim(COALESCE(p_unit, '')), ''), '个'), location = NULLIF(btrim(COALESCE(p_location, '')), ''), note = NULLIF(btrim(COALESCE(p_note, '')), ''), min_qty = GREATEST(COALESCE(p_min_qty, 0), 0), updated_at = now(), updated_by_name = v_me.name WHERE id = p_id RETURNING * INTO v_item;
    IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF;
  ELSE
    v_code := NULLIF(btrim(COALESCE(p_code, '')), '');
    IF v_code IS NULL THEN v_code := next_item_code(); END IF;
    SELECT count(*) INTO v_dup FROM items WHERE code = v_code;
    IF v_dup > 0 THEN RAISE EXCEPTION 'ITEM_CODE_TAKEN'; END IF;
    INSERT INTO items (code, name, spec, category, unit, location, note, min_qty, qty, created_by_id, created_by_name)
    VALUES (v_code, btrim(p_name), NULLIF(btrim(COALESCE(p_spec, '')), ''), NULLIF(btrim(COALESCE(p_category, '')), ''), COALESCE(NULLIF(btrim(COALESCE(p_unit, '')), ''), '个'), NULLIF(btrim(COALESCE(p_location, '')), ''), NULLIF(btrim(COALESCE(p_note, '')), ''), GREATEST(COALESCE(p_min_qty, 0), 0), 0, v_me.id, v_me.name) RETURNING * INTO v_item;
  END IF;
  RETURN json_build_object('id', v_item.id, 'code', v_item.code, 'name', v_item.name, 'spec', v_item.spec, 'category', v_item.category, 'unit', v_item.unit, 'location', v_item.location, 'qty', v_item.qty, 'min_qty', v_item.min_qty, 'note', v_item.note, 'status', v_item.status, 'created_by_name', v_item.created_by_name, 'updated_by_name', v_item.updated_by_name, 'created_at', v_item.created_at, 'updated_at', v_item.updated_at);
END $function$;

-- 批量导入：整块 TSV 交给服务端逐行建档，单行失败不影响其它行。
-- 列顺序：编号 名称 规格 类别 单位 位置 数量 安全库存 备注
CREATE OR REPLACE FUNCTION public.staff_import_items(p_token text, p_tsv text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_lines text[]; v_line text; v_cols text[]; v_code text; v_name text; v_qty integer; v_ok integer := 0; v_fail integer := 0; v_errs text[] := ARRAY[]::text[]; v_item items%ROWTYPE; BEGIN v_me := staff_require(p_token, 'manager'); IF p_tsv IS NULL OR btrim(p_tsv) = '' THEN RAISE EXCEPTION 'EMPTY_DATA'; END IF; v_lines := string_to_array(replace(replace(p_tsv, E'\r\n', E'\n'), E'\r', E'\n'), E'\n'); FOREACH v_line IN ARRAY v_lines LOOP CONTINUE WHEN btrim(v_line) = ''; v_cols := string_to_array(v_line, E'\t'); v_code := btrim(COALESCE(v_cols[1], '')); v_name := btrim(COALESCE(v_cols[2], '')); CONTINUE WHEN v_code = '' AND v_name = ''; CONTINUE WHEN v_code ILIKE '%编号%' AND v_name ILIKE '%名称%'; IF v_name = '' THEN v_fail := v_fail + 1; v_errs := v_errs || ('缺名称：' || left(v_line, 24)); CONTINUE; END IF; IF v_code = '' THEN v_code := next_item_code(); END IF; v_qty := CASE WHEN btrim(COALESCE(v_cols[7], '')) ~ '^-?[0-9]+$' THEN btrim(v_cols[7])::integer ELSE 0 END; BEGIN INSERT INTO items (code, name, spec, category, unit, location, qty, min_qty, note, created_by_id, created_by_name) VALUES (v_code, v_name, NULLIF(btrim(COALESCE(v_cols[3], '')), ''), NULLIF(btrim(COALESCE(v_cols[4], '')), ''), COALESCE(NULLIF(btrim(COALESCE(v_cols[5], '')), ''), '个'), NULLIF(btrim(COALESCE(v_cols[6], '')), ''), 0, CASE WHEN btrim(COALESCE(v_cols[8], '')) ~ '^[0-9]+$' THEN btrim(v_cols[8])::integer ELSE 0 END, NULLIF(btrim(COALESCE(v_cols[9], '')), ''), v_me.id, v_me.name) RETURNING * INTO v_item; v_ok := v_ok + 1; IF v_qty <> 0 THEN UPDATE items SET qty = v_qty, updated_at = now(), updated_by_name = v_me.name WHERE id = v_item.id; INSERT INTO stock_records (item_id, item_code, item_name, type, qty, before_qty, after_qty, owner_id, owner_name, staff_id, staff_role, staff_name, note) VALUES (v_item.id, v_item.code, v_item.name, CASE WHEN v_qty > 0 THEN 'in' ELSE 'out' END, abs(v_qty), 0, v_qty, COALESCE(auth.uid(), 'staff:' || v_me.id::text), v_me.name, v_me.id, v_me.role, v_me.name, '建档初始库存'); END IF; EXCEPTION WHEN unique_violation THEN v_fail := v_fail + 1; v_errs := v_errs || ('编号已存在：' || v_code); WHEN OTHERS THEN v_fail := v_fail + 1; v_errs := v_errs || ('写入失败：' || v_code); END; END LOOP; RETURN json_build_object('inserted', v_ok, 'failed', v_fail, 'errors', to_json(v_errs), 'operator', v_me.name); END $function$;

-- 停用 / 恢复（停用是"一等状态"，不是删除；停用后 stock_change 会拒绝出入库）
CREATE OR REPLACE FUNCTION public.staff_archive_item(p_token text, p_id bigint, p_archived boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_item items%ROWTYPE; BEGIN v_me := staff_require(p_token, 'manager'); UPDATE items SET status = CASE WHEN p_archived THEN 'archived' ELSE 'active' END, updated_at = now(), updated_by_name = v_me.name WHERE id = p_id RETURNING * INTO v_item; IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF; RETURN json_build_object('id', v_item.id, 'code', v_item.code, 'status', v_item.status); END $function$;

-- 彻底删除物品（仅管理员）
CREATE OR REPLACE FUNCTION public.staff_delete_item(p_token text, p_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_me staff%ROWTYPE; v_item items%ROWTYPE; BEGIN v_me := staff_require(p_token, 'admin'); SELECT * INTO v_item FROM items WHERE id = p_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF; DELETE FROM items WHERE id = v_item.id; RETURN json_build_object('ok', true, 'code', v_item.code, 'name', v_item.name); END $function$;


-- =============================================================================
-- 六、出入库（唯一的库存写入口）
-- =============================================================================

-- 原子出入库：行锁 → 校验 → 改库存 → 写流水，一个事务内完成。
-- 管理员被明确排除（ADMIN_NO_STOCK）：管理员负责管人与全局监控，不参与扫码出入库。
CREATE OR REPLACE FUNCTION public.stock_change(p_token text, p_code text, p_type text, p_qty integer, p_note text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me staff%ROWTYPE;
  v_item items%ROWTYPE;
  v_new integer;
  v_rec stock_records%ROWTYPE;
BEGIN
  v_me := staff_auth(p_token);
  -- 管理员负责管人与全局监控，不参与扫码出入库（界面上也不给他入口）
  IF v_me.role NOT IN ('manager', 'staff') THEN
    RAISE EXCEPTION 'ADMIN_NO_STOCK';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'INVALID_QTY'; END IF;
  IF p_type NOT IN ('in','out') THEN RAISE EXCEPTION 'INVALID_TYPE'; END IF;
  IF p_code IS NULL OR btrim(p_code) = '' THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF;
  SELECT * INTO v_item FROM items WHERE code = btrim(p_code) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF;
  IF v_item.status <> 'active' THEN RAISE EXCEPTION 'ITEM_ARCHIVED'; END IF;
  IF p_type = 'out' AND v_item.qty < p_qty THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
  v_new := CASE WHEN p_type = 'in' THEN v_item.qty + p_qty ELSE v_item.qty - p_qty END;
  UPDATE items SET qty = v_new, updated_at = now(), updated_by_name = v_me.name WHERE id = v_item.id;
  INSERT INTO stock_records (item_id, item_code, item_name, type, qty, before_qty, after_qty, owner_id, owner_name, staff_id, staff_role, staff_name, note)
  VALUES (v_item.id, v_item.code, v_item.name, p_type, p_qty, v_item.qty, v_new, COALESCE(auth.uid(), 'staff:' || v_me.id::text), v_me.name, v_me.id, v_me.role, v_me.name, NULLIF(btrim(COALESCE(p_note, '')), ''))
  RETURNING * INTO v_rec;
  RETURN json_build_object(
    'item', json_build_object('id', v_item.id, 'code', v_item.code, 'name', v_item.name, 'spec', v_item.spec, 'unit', v_item.unit, 'location', v_item.location, 'qty', v_new, 'min_qty', v_item.min_qty),
    'record', json_build_object('id', v_rec.id, 'item_code', v_rec.item_code, 'item_name', v_rec.item_name, 'type', v_rec.type, 'qty', v_rec.qty, 'before_qty', v_rec.before_qty, 'after_qty', v_rec.after_qty, 'operator_name', v_me.name, 'operator_role', v_me.role, 'note', v_rec.note, 'created_at', v_rec.created_at)
  );
END
$function$;

-- 扫码即建档 + 入库：建档与入库在一次调用里原子完成，
-- 不会出现"建了档却没进账"。管理员同样被排除。
-- 编码重复由 items_code_key 唯一索引兜底为 ITEM_CODE_TAKEN。
CREATE OR REPLACE FUNCTION public.staff_scan_create_in(
  p_token text, p_code text, p_name text, p_spec text, p_category text,
  p_unit text, p_location text, p_min_qty integer, p_qty integer, p_note text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me staff%ROWTYPE;
  v_code text;
  v_qty integer;
  v_res json;
BEGIN
  v_me := staff_auth(p_token);
  IF v_me.role NOT IN ('manager', 'staff') THEN
    RAISE EXCEPTION 'ADMIN_NO_STOCK';
  END IF;

  v_code := btrim(COALESCE(p_code, ''));
  IF v_code = '' THEN RAISE EXCEPTION 'CODE_REQUIRED'; END IF;
  IF char_length(v_code) > 106 THEN RAISE EXCEPTION 'CODE_TOO_LONG'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'ITEM_NAME_REQUIRED'; END IF;

  IF EXISTS (SELECT 1 FROM items WHERE code = v_code) THEN
    RAISE EXCEPTION 'ITEM_CODE_TAKEN';
  END IF;

  BEGIN
    INSERT INTO items (code, name, spec, category, unit, location, note, min_qty, qty, created_by_id, created_by_name)
    VALUES (
      v_code,
      btrim(p_name),
      NULLIF(btrim(COALESCE(p_spec, '')), ''),
      NULLIF(btrim(COALESCE(p_category, '')), ''),
      COALESCE(NULLIF(btrim(COALESCE(p_unit, '')), ''), '个'),
      NULLIF(btrim(COALESCE(p_location, '')), ''),
      NULLIF(btrim(COALESCE(p_note, '')), ''),
      GREATEST(COALESCE(p_min_qty, 0), 0),
      0,
      v_me.id,
      v_me.name
    );
  EXCEPTION WHEN unique_violation THEN
    -- 两个人同时扫同一个码：由 items_code_key 唯一索引兜底
    RAISE EXCEPTION 'ITEM_CODE_TAKEN';
  END;

  v_qty := GREATEST(COALESCE(p_qty, 1), 1);
  v_res := stock_change(p_token, v_code, 'in', v_qty, '扫码建档入库');

  RETURN json_build_object(
    'created', true,
    'item', v_res -> 'item',
    'record', v_res -> 'record'
  );
END
$function$;

-- 同族模板：拿 A-0001-3 去找 A-0001-* 里已建档的记录。
-- 逐件赋码时第 2 件起直接套用第 1 件填过的名称 / 规格 / 位置，不用重复填。
-- （用 left(...) 做前缀比较，避免编号里的 % _ 被当成 LIKE 通配符）
CREATE OR REPLACE FUNCTION public.staff_code_family(p_token text, p_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me staff%ROWTYPE;
  v_code text;
  v_base text;
  v_item items%ROWTYPE;
  v_cnt integer;
BEGIN
  v_me := staff_auth(p_token);
  v_code := btrim(COALESCE(p_code, ''));
  IF v_code = '' THEN RETURN NULL; END IF;

  -- A-0001-4 → A-0001（去掉末尾的 -数字 / _数字）
  v_base := regexp_replace(v_code, '[-_][0-9]+$', '');
  IF v_base = '' OR v_base = v_code THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_cnt FROM items
   WHERE left(code, char_length(v_base) + 1) = v_base || '-';
  IF v_cnt = 0 THEN RETURN NULL; END IF;

  SELECT * INTO v_item FROM items
   WHERE left(code, char_length(v_base) + 1) = v_base || '-'
   ORDER BY code LIMIT 1;

  RETURN json_build_object(
    'base', v_base,
    'count', v_cnt,
    'name', v_item.name,
    'spec', v_item.spec,
    'category', v_item.category,
    'unit', v_item.unit,
    'location', v_item.location
  );
END
$function$;


-- =============================================================================
-- 七、清理
-- =============================================================================

-- 早期版本留下的聚合统计函数：公开可执行，且库存预警口径是旧的
-- （只判 qty <= min_qty，漏了 min_qty > 0），与 staff_stats 不一致，
-- 保留只会让人误用。现已被 staff_stats 完全取代。
DROP FUNCTION IF EXISTS public.warehouse_stats();


-- =============================================================================
-- 八、执行权限
-- -----------------------------------------------------------------------------
-- PostgreSQL 新建函数默认 PUBLIC 即可执行，PostgREST 的 anon / authenticated
-- 都能调到 —— 这些函数内部各自校验令牌，所以保持默认可执行是安全的。
-- 下面四个是**令牌入口**（会话 / 家族模板 / 扫码建档），
-- 生产库对它们额外撤销了 PUBLIC，只留给 anon / authenticated，这里保持一致。
-- =============================================================================
REVOKE ALL ON FUNCTION public.staff_auth(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_require(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_code_family(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_scan_create_in(text,text,text,text,text,text,text,integer,integer,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.staff_auth(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_require(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_code_family(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_scan_create_in(text,text,text,text,text,text,text,integer,integer,text) TO anon, authenticated;

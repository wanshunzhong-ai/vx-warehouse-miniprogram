-- =============================================================================
-- 内部仓库物品管理 · 演示数据（可选）
-- -----------------------------------------------------------------------------
-- 前置：先执行 01-schema.sql → 02-functions.sql → 03-bootstrap-admin.sql
--
-- 装这个是为了让小程序一打开就有东西看：8 个物品覆盖 6 个分类，
-- 其中 2 个刻意做成低库存，用来演示「库存预警」。
--
-- 不想用可以直接跳过；或者用完随时在小程序里「停用 / 删除」掉。
--
-- 说明：这里直接 INSERT 建期初库存（生产环境应当只走 stock_change()）。
-- 种子数据这样写是为了省事且保证 before_qty / after_qty 链条自洽：
-- 每个物品一条「期初建账」流水，before_qty = 0，after_qty = 当前库存。
-- =============================================================================

DO $demo$
DECLARE
  r record;
  v_me public.staff%ROWTYPE;
  v_item public.items%ROWTYPE;
  v_seed constant json := '[
    {"code":"A-0001","name":"活动扳手","spec":"8 寸","category":"五金","unit":"把","location":"货架 A-1","qty":6,"min_qty":3},
    {"code":"A-0002","name":"内六角扳手套装","spec":"1.5-10mm","category":"五金","unit":"套","location":"货架 A-1","qty":2,"min_qty":3},
    {"code":"B-0001","name":"绝缘胶带","spec":"3M 18mm","category":"电气","unit":"卷","location":"货架 B-2","qty":40,"min_qty":10},
    {"code":"B-0002","name":"LED 灯泡","spec":"12W E27","category":"电气","unit":"只","location":"货架 B-2","qty":5,"min_qty":10},
    {"code":"C-0001","name":"劳保手套","spec":"防切割 5 级","category":"劳保","unit":"副","location":"货架 C-1","qty":60,"min_qty":20},
    {"code":"D-0001","name":"A4 复印纸","spec":"70g 500 张","category":"办公","unit":"包","location":"货架 D-3","qty":12,"min_qty":5},
    {"code":"E-0001","name":"数显卡尺","spec":"0-150mm","category":"工量具","unit":"把","location":"工具柜 1","qty":3,"min_qty":1},
    {"code":"F-0001","name":"气泡膜","spec":"宽 50cm","category":"包装","unit":"卷","location":"货架 F-1","qty":8,"min_qty":0}
  ]'::json;
BEGIN
  SELECT * INTO v_me FROM public.staff WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION '还没有可用的管理员账号，请先执行 03-bootstrap-admin.sql';
  END IF;

  FOR r IN SELECT * FROM json_to_recordset(v_seed) AS x(
      code text, name text, spec text, category text, unit text,
      location text, qty integer, min_qty integer)
  LOOP
    IF EXISTS (SELECT 1 FROM public.items WHERE code = r.code) THEN
      RAISE NOTICE '编号 % 已存在，跳过', r.code;
      CONTINUE;
    END IF;

    INSERT INTO public.items (code, name, spec, category, unit, location, qty, min_qty, created_by_id, created_by_name)
    VALUES (r.code, r.name, r.spec, r.category, r.unit, r.location, r.qty, r.min_qty, v_me.id, v_me.name)
    RETURNING * INTO v_item;

    -- 期初建账流水（before 0 → after 当前库存），让流水页一打开就有内容
    INSERT INTO public.stock_records (item_id, item_code, item_name, type, qty, before_qty, after_qty,
                                     owner_id, owner_name, staff_id, staff_role, staff_name, note)
    VALUES (v_item.id, v_item.code, v_item.name, 'in', v_item.qty, 0, v_item.qty,
            'seed', v_me.name, v_me.id, v_me.role, v_me.name, '期初建账');
  END LOOP;

  RAISE NOTICE '演示数据已就绪：% 个在用物品，% 条流水',
    (SELECT count(*) FROM public.items WHERE status = 'active'),
    (SELECT count(*) FROM public.stock_records);
END
$demo$;

-- 核对：应看到 2 个低库存（A-0002 内六角扳手 2/3、B-0002 LED 灯泡 5/10）
-- SELECT code, name, qty, min_qty FROM public.low_stock_items(50) ORDER BY code;

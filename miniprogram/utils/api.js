/**
 * 数据访问层
 *
 * 约定：
 *   - 只读查询（物品档案）直接走数据库，登录后即可读；
 *   - 一切写入（建档 / 改档 / 删除 / 出入库 / 导入）都走服务端函数，
 *     函数内部用登录令牌校验角色，客户端无法越权；
 *   - 出入库流水完全不对外开放直读，只能通过带令牌的接口取。
 */
const { getDB } = require('./cloud')
const rpc = require('./rpc')
const util = require('./util')

const ITEM_COLUMNS =
  'id,code,name,spec,category,unit,location,qty,min_qty,note,status,photo,created_by_name,updated_by_name,created_at,updated_at'

/* ---------------- 物品（只读） ---------------- */

/**
 * 分页查询物品
 * options: { keyword, category, status, page, pageSize }
 */
async function listItems(options) {
  const opt = options || {}
  const page = opt.page || 1
  const pageSize = opt.pageSize || 20
  let q = getDB()
    .from('items')
    .select(ITEM_COLUMNS, { count: 'exact' })
    .eq('status', opt.status || 'active')

  if (opt.keyword) {
    const kw = String(opt.keyword).replace(/[%,()*]/g, '')
    if (kw) {
      q = q.or(
        'code.ilike.%' + kw + '%,' +
        'name.ilike.%' + kw + '%,' +
        'spec.ilike.%' + kw + '%,' +
        'location.ilike.%' + kw + '%'
      )
    }
  }
  if (opt.category) q = q.eq('category', opt.category)

  const from = (page - 1) * pageSize
  const res = await q.order('updated_at', { ascending: false }).range(from, from + pageSize - 1)
  const rows = rpc.unwrap(res) || []
  return {
    list: Array.isArray(rows) ? rows : [],
    count: res && typeof res.count === 'number' ? res.count : 0
  }
}

async function getItemByCode(code) {
  const res = await getDB().from('items').select(ITEM_COLUMNS).eq('code', code).maybeSingle()
  return rpc.unwrap(res)
}

async function getItemById(id) {
  const res = await getDB().from('items').select(ITEM_COLUMNS).eq('id', id).maybeSingle()
  return rpc.unwrap(res)
}

/** 生成一个建议编号，如 WP0007（服务端函数，无副作用） */
async function suggestCode() {
  return rpc.callPublic('next_item_code')
}

/** 全部分类（用于筛选），默认只看在用的 */
async function listCategories(status) {
  const res = await getDB()
    .from('items')
    .select('category')
    .eq('status', status || 'active')
    .not('category', 'is', null)
    .limit(500)
  const rows = rpc.unwrap(res) || []
  const set = {}
  ;(Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (r.category && r.category.trim()) set[r.category.trim()] = true
  })
  return Object.keys(set).sort()
}

/** 低库存物品（服务端函数） */
async function lowStockItems(limit) {
  const rows = await rpc.callPublic('low_stock_items', { p_limit: limit || 20 })
  return Array.isArray(rows) ? rows : rows ? [rows] : []
}

/** 一次性拉取用于导出的清单 */
async function exportItems() {
  const res = await getDB()
    .from('items')
    .select(ITEM_COLUMNS)
    .eq('status', 'active')
    .order('code', { ascending: true })
    .limit(1000)
  const rows = rpc.unwrap(res)
  return Array.isArray(rows) ? rows : []
}

/* ---------------- 物品（写入，需主管及以上） ---------------- */

/**
 * 建档 / 改档（同一个接口）
 * payload: { id, code, name, spec, category, unit, location, note, min_qty }
 * id 为空表示新建；code 为空时服务端自动生成
 */
async function saveItem(payload) {
  const p = payload || {}
  return rpc.call('staff_save_item', {
    p_id: p.id || null,
    p_code: p.code || null,
    p_name: p.name,
    p_spec: p.spec || null,
    p_category: p.category || null,
    p_unit: p.unit || null,
    p_location: p.location || null,
    p_note: p.note || null,
    p_min_qty: p.min_qty == null ? 0 : p.min_qty
  })
}

/** 停用 / 恢复物品（停用后不可出入库，历史记录保留） */
async function archiveItem(id, archived) {
  return rpc.call('staff_archive_item', { p_id: id, p_archived: !!archived })
}

/**
 * 记录 / 清除物品的位置照片
 * photo 传云端存储的对象路径；传 null 表示清除（照片已删除或换新）
 */
async function setItemPhoto(id, photo) {
  return rpc.call('staff_item_photo', { p_id: id, p_photo: photo || null })
}

/** 删除物品（仅管理员） */
async function deleteItem(id) {
  return rpc.call('staff_delete_item', { p_id: id })
}

/**
 * 批量导入：把 TSV（制表符分隔）整块交给服务端逐行建档。
 * 每行：编号 名称 规格 类别 单位 位置 数量 安全库存 备注
 */
async function importItems(rows, errors) {
  if (errors && errors.length) {
    throw new Error(errors[0])
  }
  const lines = (rows || []).map(function (r) {
    return [
      r.code || '',
      r.name || '',
      r.spec || '',
      r.category || '',
      r.unit || '',
      r.location || '',
      r.qty == null ? 0 : r.qty,
      r.min_qty == null ? 0 : r.min_qty,
      (r.note || '').replace(/[\t\r\n]/g, ' ')
    ].join('\t')
  })
  return rpc.call('staff_import_items', { p_tsv: lines.join('\n') })
}

/* ---------------- 出入库 ---------------- */

/**
 * 扫码建档 + 入库（一步到位，员工也可用）
 * 适合「先把码贴到货上、扫码时才建档」的作业方式：
 * 服务端建档后立刻走一次入库，档案与流水一起落库，不会出现「建了档却没进账」。
 */
async function scanCreateIn(payload) {
  const p = payload || {}
  return rpc.call('staff_scan_create_in', {
    p_code: p.code,
    p_name: p.name,
    p_spec: p.spec || null,
    p_category: p.category || null,
    p_unit: p.unit || null,
    p_location: p.location || null,
    p_min_qty: p.min_qty == null ? 0 : p.min_qty,
    p_qty: p.qty == null ? 1 : p.qty,
    p_note: p.note || null
  })
}

/**
 * 查同族物品：拿 A-0001-3 去找 A-0001-* 里已建档的记录。
 * 未建档时用它当模板，逐件贴码就不必把名称规格重复填 N 遍。
 */
async function codeFamily(code) {
  return rpc.call('staff_code_family', { p_code: code })
}

/** 原子出入库：服务端加行锁 + 写流水 + 记录操作人身份 */
async function changeStock(code, type, qty, note) {
  const data = await rpc.call('stock_change', {
    p_code: code,
    p_type: type,
    p_qty: qty,
    p_note: note || null
  })
  if (!data || !data.item) throw new Error('操作未生效，请重试')
  return data
}

/**
 * 出入库流水
 * options: { itemCode, type, todayOnly, page, pageSize, scope }
 * scope: 'all' 全仓 / 'mine' 只看我自己的
 */
async function listRecords(options) {
  const opt = options || {}
  const data = await rpc.call('staff_list_records', {
    p_item_code: opt.itemCode || null,
    p_type: opt.type || null,
    p_today_only: !!opt.todayOnly,
    p_page: opt.page || 1,
    p_page_size: opt.pageSize || 20,
    p_scope: opt.scope || 'all'
  })
  const d = data || {}
  return {
    list: d.list || [],
    total: d.total || 0,
    sumIn: d.sum_in || 0,
    sumOut: d.sum_out || 0
  }
}

/** 导出流水（主管及以上） */
async function exportRecords(limit) {
  const rows = await rpc.call('staff_export_records', { p_limit: limit || 1000 })
  return Array.isArray(rows) ? rows : []
}

/**
 * 仓库统计
 * scope: 'all' 全仓 / 'mine' 与我相关
 */
async function stats(scope) {
  const data = await rpc.call('staff_stats', { p_scope: scope || 'all' })
  return data || {}
}

/* ---------------- 账号与人员 ---------------- */

/** 人员概览（首页用） */
async function staffOverview() {
  return rpc.call('staff_overview') || {}
}

/** 人员列表：管理员看全部，主管只看自己提交的 */
async function listStaff(filter) {
  const f = filter || {}
  const rows = await rpc.call('staff_list', {
    p_status: f.status || 'all',
    p_role: f.role || 'all',
    p_keyword: f.keyword || null
  })
  return Array.isArray(rows) ? rows : []
}

/**
 * 添加账号
 * 管理员：直接生效；主管：提交后进入待审批
 * 返回 { staff, initial_password, need_review }
 */
async function createStaff(payload) {
  const p = payload || {}
  return rpc.call('staff_create', {
    p_username: p.username,
    p_name: p.name,
    p_role: p.role || 'staff',
    p_phone: p.phone || null,
    p_dept: p.dept || null,
    p_remark: p.remark || null,
    p_password: p.password || null
  })
}

/** 审批（仅管理员）：通过 / 驳回 */
async function reviewStaff(id, approve, role, note) {
  return rpc.call('staff_review', {
    p_staff_id: id,
    p_approve: !!approve,
    p_role: role || null,
    p_note: note || null
  })
}

/** 修改账号资料 / 角色 / 启停（仅管理员） */
async function updateStaff(payload) {
  const p = payload || {}
  return rpc.call('staff_update', {
    p_staff_id: p.id,
    p_name: p.name || null,
    p_phone: p.phone || null,
    p_dept: p.dept || null,
    p_role: p.role || null,
    p_status: p.status || null
  })
}

/** 重置密码（仅管理员），不传新密码则服务端随机生成并返回 */
async function resetStaffPassword(id, password) {
  return rpc.call('staff_reset_password', { p_staff_id: id, p_password: password || null })
}

/** 删除账号（仅管理员） */
async function deleteStaff(id) {
  return rpc.call('staff_delete_account', { p_staff_id: id })
}

module.exports = {
  listItems: listItems,
  getItemByCode: getItemByCode,
  getItemById: getItemById,
  suggestCode: suggestCode,
  listCategories: listCategories,
  lowStockItems: lowStockItems,
  exportItems: exportItems,
  saveItem: saveItem,
  archiveItem: archiveItem,
  setItemPhoto: setItemPhoto,
  deleteItem: deleteItem,
  importItems: importItems,
  scanCreateIn: scanCreateIn,
  codeFamily: codeFamily,
  changeStock: changeStock,
  listRecords: listRecords,
  exportRecords: exportRecords,
  stats: stats,
  staffOverview: staffOverview,
  listStaff: listStaff,
  createStaff: createStaff,
  reviewStaff: reviewStaff,
  updateStaff: updateStaff,
  resetStaffPassword: resetStaffPassword,
  deleteStaff: deleteStaff
}

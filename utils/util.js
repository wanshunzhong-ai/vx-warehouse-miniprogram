/** 通用工具函数 */
const roles = require('./roles')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 把 ISO 时间格式化为 2026-10-07 10:36 */
function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) +
    ':' + pad(d.getMinutes())
  )
}

/** 只保留日期 2026-10-07 */
function formatDate(iso) {
  const full = formatDateTime(iso)
  return full ? full.slice(0, 10) : ''
}

/** 相对时间：刚刚 / 5 分钟前 / 昨天 14:20 */
function fromNow(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 48 * 60 * 60 * 1000) return '昨天 ' + formatDateTime(iso).slice(11)
  return formatDate(iso)
}

/** 今天 0 点对应的 ISO 字符串，用于按天筛选 */
function todayStartISO() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function toast(title, icon) {
  wx.showToast({ title: title, icon: icon || 'none', duration: 1800 })
}

function loading(title) {
  wx.showLoading({ title: title || '处理中', mask: true })
}

function hideLoading() {
  wx.hideLoading()
}

/** 服务端业务错误码 → 中文提示 */
const ERROR_MAP = [
  [/INVALID_CREDENTIALS|LOGIN_FAILED/, '账号或密码不正确'],
  [/ACCOUNT_PENDING/, '账号还在等待管理员审批，暂时不能登录'],
  [/ACCOUNT_REJECTED/, '这次开通申请已被驳回，请联系你的主管'],
  [/ACCOUNT_DISABLED/, '账号已被停用，请联系管理员'],
  [/USERNAME_TAKEN/, '这个登录账号已经被占用了'],
  [/USERNAME_INVALID/, '登录账号只能是 3-24 位字母、数字、下划线、点或横线'],
  [/USERNAME_REQUIRED/, '请填写登录账号'],
  [/NAME_REQUIRED/, '请填写姓名'],
  [/PASSWORD_TOO_SHORT/, '密码至少 6 位'],
  [/OLD_PASSWORD_WRONG/, '原密码不正确'],
  [/LAST_ADMIN/, '至少要保留一名管理员，操作已阻止'],
  [/CANNOT_REVIEW_SELF/, '不能审批自己的账号'],
  [/CANNOT_DELETE_SELF/, '不能删除自己的账号'],
  [/CANNOT_MODIFY_SELF/, '不能修改自己的角色或停用自己'],
  [/NOT_PENDING/, '这条申请已经处理过了'],
  [/NEED_REVIEW/, '待审批的账号请走审批流程'],
  [/NOT_YOUR_STAFF/, '只能管理你自己提交的员工账号'],
  [/ROLE_LOCKED/, '主管不能修改员工的身份，需要管理员操作'],
  [/ADMIN_NO_STOCK/, '管理员不参与出入库，请由主管或员工操作'],
  [/STAFF_NOT_FOUND/, '没有找到这个账号'],
  [/INVALID_STATUS/, '状态值不正确'],
  [/NO_PERMISSION/, '当前身份没有这个权限'],
  [/NOT_SIGNED_IN|SESSION_EXPIRED/, '登录已过期，请重新登录'],
  [/EMPLOYEE_NOT_ALLOWED/, '员工账号不能自己注册，请让主管帮你开通'],
  [/ITEM_NOT_FOUND/, '仓库里没有这个编号的物品'],
  [/ITEM_ARCHIVED/, '该物品已停用，不能出入库'],
  [/ITEM_CODE_TAKEN/, '该物品编号已存在，换一个吧'],
  [/INSUFFICIENT_STOCK/, '库存不足，无法出库'],
  [/INVALID_QTY/, '请输入大于 0 的数量'],
  [/INVALID_TYPE/, '操作类型不正确'],
  [/EMPTY_DATA/, '没有可导入的数据'],
  [/23505|duplicate key/i, '该编号已存在，换一个吧'],
  [/42501|permission denied/i, '没有权限执行该操作'],
  [/network|request:fail|timeout/i, '网络不稳定，请检查后重试'],
  [/unauthenticated|invalid_grant|401/i, '登录已失效，请重新登录']
]

/** 把错误对象翻译成用户能看懂的一句话 */
function friendlyError(err) {
  if (!err) return '操作失败，请重试'
  const msg = err.message || err.errMsg || String(err)
  for (let i = 0; i < ERROR_MAP.length; i++) {
    if (ERROR_MAP[i][0].test(msg)) return ERROR_MAP[i][1]
  }
  return msg.length > 40 ? '操作失败，请重试' : msg
}

/** 解析粘贴的 CSV / TSV 文本为物品数组 */function parseSheet(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(function (l) { return l.trim() })
    .filter(function (l) { return l.length > 0 })
  const rows = []
  const errors = []
  const HEADER = /^(编号|物品编号|code|序号|no\.?|名称|name)$/i

  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i]
      .split(/\t|,|，/)
      .map(function (c) { return c.trim().replace(/^"|"$/g, '') })

    if (i === 0 && (HEADER.test(cols[0] || '') || HEADER.test(cols[1] || ''))) continue

    const code = cols[0] || ''
    const name = cols[1] || ''
    if (!code && !name) continue
    if (!name) {
      errors.push('第 ' + (i + 1) + ' 行缺少物品名称')
      continue
    }
    const qty = parseInt(cols[6], 10)
    const minQty = parseInt(cols[7], 10)
    rows.push({
      code: code,
      name: name,
      spec: cols[2] || '',
      category: cols[3] || '',
      unit: cols[4] || '个',
      location: cols[5] || '',
      qty: isNaN(qty) || qty < 0 ? 0 : qty,
      min_qty: isNaN(minQty) || minQty < 0 ? 0 : minQty,
      note: cols[8] || ''
    })
  }
  return { rows: rows, errors: errors }
}

/** 出入库记录：补齐 wxml 里不能算的字段（WXML 表达式不支持方法调用） */
function decorateRecord(r) {
  if (!r) return r
  r.timeText = fromNow(r.created_at)
  r.fullTime = formatDateTime(r.created_at)
  r.isIn = r.type === 'in'
  r.typeLabel = r.isIn ? '入库' : '出库'
  r.qtyText = (r.isIn ? '+' : '-') + r.qty
  r.operatorText = r.operator_name || '—'
  r.operatorRoleText = r.operator_role ? roles.roleLabel(r.operator_role) : ''
  return r
}

function decorateRecords(list) {
  return (list || []).map(decorateRecord)
}

/** 物品：补齐首字、低库存标记、停用标记 */
function decorateItem(it) {
  if (!it) return it
  const min = Number(it.min_qty || 0)
  const qty = Number(it.qty || 0)
  // 已停用的物品不该再报"库存偏低"——那是用于补货提醒的，停用了就不补了
  it.isArchived = it.status === 'archived'
  it.isLow = !it.isArchived && qty <= min
  it.statusLabel = roles.statusLabel(it.status)
  it.initial = it.name ? String(it.name).charAt(0) : '#'
  it.qtyText = String(qty) + (it.unit || '')
  return it
}

function decorateItems(list) {
  return (list || []).map(decorateItem)
}

/** 人员账号：补齐角色/状态中文与标签色 */
function decorateStaff(s) {
  if (!s) return s
  s.roleLabel = roles.roleLabel(s.role)
  s.statusLabel = roles.statusLabel(s.status)
  s.statusClass = roles.statusTag(s.status)
  s.initial = s.name ? String(s.name).charAt(0) : '#'
  s.lastLoginText = s.last_login_at ? formatDateTime(s.last_login_at) : '从未登录'
  s.createdText = formatDate(s.created_at)
  return s
}

function decorateStaffList(list) {
  return (list || []).map(decorateStaff)
}

/** 按当前时间问候 */
function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

module.exports = {
  formatDateTime: formatDateTime,
  formatDate: formatDate,
  fromNow: fromNow,
  todayStartISO: todayStartISO,
  toast: toast,
  loading: loading,
  hideLoading: hideLoading,
  friendlyError: friendlyError,
  parseSheet: parseSheet,
  decorateRecord: decorateRecord,
  decorateRecords: decorateRecords,
  decorateItem: decorateItem,
  decorateItems: decorateItems,
  decorateStaff: decorateStaff,
  decorateStaffList: decorateStaffList,
  greeting: greeting
}

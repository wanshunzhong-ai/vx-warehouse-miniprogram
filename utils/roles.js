/**
 * 角色与权限的唯一真源
 *
 * 客户端用它来决定「显示什么、能点什么」，服务端还有一层 staff_require 兜底，
 * 所以就算有人绕过界面直接调接口，也拿不到越权的数据。
 *
 * 角色层级：管理员(3) > 主管(2) > 员工(1)
 */

const ROLE_INFO = {
  admin: {
    key: 'admin',
    label: '管理员',
    short: '管',
    rank: 3,
    homeTitle: '管理中心',
    accent: '#7c4dff',
    accentSoft: 'rgba(124, 77, 255, 0.12)',
    desc: '管理主管账号、审批员工、监控全仓动向（不参与出入库）'
  },
  manager: {
    key: 'manager',
    label: '主管',
    short: '主',
    rank: 2,
    homeTitle: '主管台',
    accent: '#2f6df6',
    accentSoft: 'rgba(47, 109, 246, 0.12)',
    desc: '管理自己提交的员工、建档、导入、出入库、导出'
  },
  staff: {
    key: 'staff',
    label: '员工',
    short: '员',
    rank: 1,
    homeTitle: '工作台',
    accent: '#0ca678',
    accentSoft: 'rgba(12, 166, 120, 0.12)',
    desc: '扫码入库、扫码出库、查询物品与库存'
  }
}

/**
 * 能力清单：页面里统一用 can(role, 'xxx') 判断
 *
 * 注意几点「刻意为之」的差异：
 *  - 管理员**没有** stock.change —— 管理员管的是人（主管）与全局监控，不参与扫码出入库。
 *  - 主管有 stock.change（可以对物品出入库），也有 staff.manage
 *    （但服务端限定为「只能管自己提交的员工」，且不能改角色）。
 *  - 员工只有查看与出入库，没有建档/停用等档案类能力。
 *  - item.quickcreate 是「扫码建档」专用通道：扫到的码还没档案时，现场填个名称就
 *    建档 + 入库。它是出入库链路的延伸，所以员工也有；管理员照旧不参与。
 *    它**不等于** item.create —— 员工仍然进不了「新建物品」页，也删不了档。
 *  - item.photo 是「给物品拍一张位置照片」：它记录的是现场事实（这件东西在货架哪一层），
 *    不是账目信息，也动不了库存，所以三种身份都给 —— 谁在现场谁拍。
 *    真正影响账目的能力（建档 / 停用 / 删除 / 出入库）照旧分开管。
 */
const CAPS = {
  admin: [
    'item.view',
    'item.create',
    'item.edit',
    'item.archive',
    'item.delete',
    'item.import',
    'item.photo',
    'staff.add',
    'staff.review',
    'staff.manage',
    'record.export',
    'account.self'
  ],
  manager: [
    'item.view',
    'item.create',
    'item.edit',
    'item.archive',
    'item.import',
    'item.quickcreate',
    'item.photo',
    'stock.change',
    'staff.add',
    'staff.manage',
    'record.export',
    'account.self'
  ],
  staff: ['item.view', 'stock.change', 'item.quickcreate', 'item.photo', 'account.self']
}

/** tabBar 里可用的页签（key 必须与 app.json 的 tabBar 顺序无关，只作标识） */
const TAB_DEFS = {
  index: { key: 'index', pagePath: '/pages/index/index', icon: 'grid' },
  items: { key: 'items', pagePath: '/pages/items/items', icon: 'box' },
  scan: { key: 'scan', pagePath: '/pages/scan/scan', icon: 'scan' },
  records: { key: 'records', pagePath: '/pages/records/records', icon: 'list' },
  my: { key: 'my', pagePath: '/pages/my/my', icon: 'user' }
}

/** 每个角色看到的底部导航不一样——这是「不同后台」最直观的差异 */
const TAB_SETS = {
  admin: ['index', 'items', 'records', 'my'],
  manager: ['index', 'items', 'scan', 'records', 'my'],
  staff: ['index', 'items', 'scan', 'records', 'my']
}

const TAB_TEXTS = {
  admin: { index: '管理中心', items: '物品', records: '全仓记录', my: '我的' },
  manager: { index: '主管台', items: '物品', scan: '扫码', records: '记录', my: '我的' },
  staff: { index: '工作台', items: '物品', scan: '扫码', records: '记录', my: '我的' }
}

/**
 * 哪个角色的哪个页签要做成「凸起的大按钮」
 *
 * 员工的核心工作就是扫码出入库，所以给它一个独立的、比普通页签更醒目的入口
 * （底部导航正中间凸起的圆形按钮），而不是混在普通页签里。
 * 主管/管理员的扫码只是顺带用一下，保持普通页签样式。
 */
const RAISED_TAB = { staff: 'scan' }

function normalize(role) {
  return ROLE_INFO[role] ? role : 'staff'
}

function info(role) {
  return ROLE_INFO[normalize(role)]
}

function label(role) {
  return info(role).label
}

function rank(role) {
  return info(role).rank
}

/** 角色名（中文）→ 用于展示 */
function roleLabel(role) {
  return ROLE_INFO[role] ? ROLE_INFO[role].label : '未知身份'
}

/** 状态名（中文） */
const STATUS_LABEL = {
  pending: '待审批',
  active: '正常',
  rejected: '已驳回',
  disabled: '已停用',
  archived: '已停用'
}

function statusLabel(status) {
  return STATUS_LABEL[status] || status || ''
}

function statusTag(status) {
  if (status === 'active') return 'tag-green'
  if (status === 'pending') return 'tag-orange'
  if (status === 'rejected') return 'tag-red'
  if (status === 'disabled') return 'tag-gray'
  return 'tag-gray'
}

function tabBar(role) {
  const r = normalize(role)
  const keys = TAB_SETS[r] || TAB_SETS.staff
  const texts = TAB_TEXTS[r] || TAB_TEXTS.staff
  const raisedKey = RAISED_TAB[r]
  return keys.map(function (k) {
    const def = TAB_DEFS[k]
    return {
      key: def.key,
      icon: def.icon,
      pagePath: def.pagePath,
      text: texts[k] || def.key,
      // 凸起大按钮：自定义 tabBar 会把它渲染成正中间那个圆形按钮
      raised: !!raisedKey && k === raisedKey
    }
  })
}

/** 当前角色的导航里有没有凸起大按钮 */
function hasRaised(role) {
  return !!RAISED_TAB[normalize(role)]
}

/** 凸起按钮对应的页签 key（没有则返回 ''） */
function raisedKey(role) {
  return RAISED_TAB[normalize(role)] || ''
}

function tabIndex(role, key) {
  const list = tabBar(role)
  for (let i = 0; i < list.length; i++) {
    if (list[i].key === key) return i
  }
  return -1
}

function can(role, cap) {
  const list = CAPS[normalize(role)]
  return list.indexOf(cap) !== -1
}

/** 一次性算出一组能力，挂到 page.data 上给 wxml 用 */
function caps(role) {
  const list = CAPS[normalize(role)]
  const out = {}
  list.forEach(function (c) {
    out[c.replace(/\./g, '_')] = true
  })
  return out
}

module.exports = {
  ROLE_INFO: ROLE_INFO,
  CAPS: CAPS,
  RAISED_TAB: RAISED_TAB,
  info: info,
  label: label,
  rank: rank,
  roleLabel: roleLabel,
  statusLabel: statusLabel,
  statusTag: statusTag,
  tabBar: tabBar,
  tabIndex: tabIndex,
  hasRaised: hasRaised,
  raisedKey: raisedKey,
  can: can,
  caps: caps
}

const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const roles = require('../../utils/roles')
const page = require('../../utils/page')

/** 与 pages/items/items.js 约定同一份缓存键，用于 switchTab 传筛选条件 */
const ITEMS_FILTER_KEY = 'warehouse_items_filter'

/** 与 pages/scan/scan.js 约定同一份缓存键：工作台点「扫码入库/出库」后直达扫码 */
const SCAN_DIR_KEY = 'warehouse_scan_dir'

Page({
  data: {
    ready: false,
    role: '',
    roleMeta: roles.info('staff'),
    profile: {},
    caps: {},

    todayText: '',
    greeting: '',
    /* 共用 */
    stat: {},
    lowItems: [],
    recent: [],
    /* 管理员 */
    overview: {},
    pendingList: [],
    /* 员工 */
    myStat: {}
  },

  onLoad() {
    this.setData({
      todayText: util.formatDate(new Date().toISOString()),
      greeting: util.greeting()
    })
  },

  onShow() {
    const role = auth.currentRole() || 'staff'
    // 导航标题、tabBar 选中态、能力标记都由这里统一对齐
    page.setup(this, { tab: 'index', title: roles.info(role).homeTitle })
    // 先按本地缓存的角色渲染一遍，避免白屏
    if (!this.data.ready) {
      const cached = auth.currentProfile()
      this.setData({
        role: role,
        roleMeta: roles.info(role),
        profile: cached ? util.decorateStaff(cached) : {},
        caps: roles.caps(role)
      })
    }
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh(() => wx.stopPullDownRefresh())
  },

  async refresh(done) {
    const me = await app.ensureLogin()
    if (!me) {
      if (done) done()
      return
    }

    this.setData({
      ready: true,
      role: me.role,
      roleMeta: roles.info(me.role),
      profile: util.decorateStaff(Object.assign({}, me)),
      caps: roles.caps(me.role)
    })

    try {
      if (me.role === 'admin') await this.loadAdmin()
      else if (me.role === 'manager') await this.loadManager()
      else await this.loadStaff()
    } catch (e) {
      util.toast(util.friendlyError(e))
    }

    if (done) done()
  },

  /* ---------------- 管理员：管理中心 ---------------- */

  async loadAdmin() {
    const res = await Promise.all([
      api.staffOverview(),
      api.stats('all'),
      api.lowStockItems(5),
      api.listRecords({ pageSize: 6, scope: 'all' }),
      api.listStaff({ status: 'pending' })
    ])
    const pending = util.decorateStaffList(res[4] || [])
    this.setData({
      overview: res[0] || {},
      stat: res[1] || {},
      lowItems: util.decorateItems(res[2] || []),
      recent: util.decorateRecords((res[3] && res[3].list) || []),
      pendingList: pending.slice(0, 3)
    })
  },

  /* ---------------- 主管：主管台 ---------------- */

  async loadManager() {
    const res = await Promise.all([
      api.staffOverview(),
      api.stats('all'),
      api.lowStockItems(5),
      api.listRecords({ pageSize: 6, scope: 'all' })
    ])
    this.setData({
      overview: res[0] || {},
      stat: res[1] || {},
      lowItems: util.decorateItems(res[2] || []),
      recent: util.decorateRecords((res[3] && res[3].list) || [])
    })
  },

  /* ---------------- 员工：我的工作台 ---------------- */

  async loadStaff() {
    const res = await Promise.all([
      api.stats('mine'),
      api.listRecords({ pageSize: 8, scope: 'mine' })
    ])
    this.setData({
      myStat: res[0] || {},
      recent: util.decorateRecords((res[1] && res[1].list) || [])
    })
  },

  /* ---------------- 跳转 ---------------- */

  goScan() {
    wx.switchTab({ url: '/pages/scan/scan' })
  },

  /**
   * 工作台上的两个方向入口：把方向写进缓存再切页，
   * 扫码页 onShow 读到后立刻拉起扫码（switchTab 不支持带参数）
   */
  goScanDir(e) {
    const dir = (e && e.currentTarget && e.currentTarget.dataset.dir) === 'out' ? 'out' : 'in'
    wx.setStorageSync(SCAN_DIR_KEY, dir)
    wx.switchTab({ url: '/pages/scan/scan' })
  },

  goItems() {
    wx.removeStorageSync(ITEMS_FILTER_KEY)
    wx.switchTab({ url: '/pages/items/items' })
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/records' })
  },

  /** 走进出库操作页（扫码页用完也会来这） */
  goManual() {
    wx.navigateTo({ url: '/pages/stock/stock?manual=1' })
  },

  goEdit(e) {
    const code = (e && e.currentTarget && e.currentTarget.dataset.code) || ''
    wx.navigateTo({
      url: '/pages/edit/edit' + (code ? '?code=' + encodeURIComponent(code) : '')
    })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  goStaff(e) {
    const status = (e && e.currentTarget && e.currentTarget.dataset.status) || ''
    wx.navigateTo({
      url: '/pages/staff/staff' + (status ? '?status=' + status : '')
    })
  },

  goAddStaff() {
    wx.navigateTo({ url: '/pages/staff-edit/staff-edit' })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  openItem(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  },

  openRecord(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/detail/detail?code=' + encodeURIComponent(code) })
  },

  goLowStock() {
    // switchTab 不支持带 query，用缓存把「只看库存预警」传给物品页
    wx.setStorageSync(ITEMS_FILTER_KEY, { low: true })
    wx.switchTab({ url: '/pages/items/items' })
  }
})

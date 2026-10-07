const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const page = require('../../utils/page')

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'active', label: '正常' },
  { key: 'disabled', label: '已停用' },
  { key: 'rejected', label: '已驳回' }
]

Page({
  data: {
    role: '',
    caps: {},
    filters: FILTERS,
    activeKey: 'all',
    keyword: '',
    list: [],
    overview: {},
    /* 顶部概览是否已回来；没回来时用灰条占位，避免数字从 0 跳变 */
    ovReady: false,
    loading: true,
    isAdmin: false
  },

  onLoad(options) {
    const opts = options || {}
    if (opts.status) this.setData({ activeKey: opts.status })
  },

  onShow() {
    const r = auth.currentRole()
    this.setData({ isAdmin: r === 'admin' })
    page.setup(this, {
      title: r === 'admin' ? '人员管理' : '我提交的账号申请'
    })
    this.reload()
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer)
  },

  onPullDownRefresh() {
    this.reload(function () {
      wx.stopPullDownRefresh()
    })
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => this.reload(), 350)
  },

  clearKeyword() {
    this.setData({ keyword: '' })
    this.reload()
  },

  pickFilter(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeKey) return
    this.setData({ activeKey: key })
    this.reload()
  },

  async reload(done) {
    const me = await app.ensureLogin()
    if (!me) {
      if (done) done()
      return
    }

    this.setData({ loading: true })
    try {
      const results = await Promise.all([
        api.listStaff({
          status: this.data.activeKey,
          keyword: this.data.keyword.trim()
        }),
        api.staffOverview()
      ])
      this.setData({
        list: util.decorateStaffList(results[0] || []),
        overview: results[1] || {},
        ovReady: true,
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(util.friendlyError(e))
    }
    if (done) done()
  },

  openStaff(e) {
    const d = e.currentTarget.dataset
    wx.navigateTo({ url: '/pages/staff-edit/staff-edit?id=' + d.id })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/staff-edit/staff-edit' })
  },

  /**
   * 列表上直接快速审批（管理员）。
   * 通过＝把对方变成可登录的正式账号（选「主管」还会连带提权），
   * 一旦点错就生效、且账号立刻能登录，所以这里一律先弹二次确认。
   */
  quickReview(e) {
    const d = e.currentTarget.dataset
    const doApply = (approve, role, note) => {
      util.loading('处理中')
      api
        .reviewStaff(d.id, approve, role, note)
        .then(() => {
          util.hideLoading()
          util.toast(approve ? '已通过' : '已驳回', 'success')
          this.reload()
        })
        .catch((err) => {
          util.hideLoading()
          util.toast(util.friendlyError(err))
        })
    }

    const confirmThen = (approve, role, note) => {
      const roleText = role === 'manager' ? '主管' : '员工'
      const action = approve ? '通过并设为' + roleText : '驳回'
      wx.showModal({
        title: '确认' + (approve ? '通过' : '驳回'),
        content: approve
          ? '将「' + d.name + '」的申请通过，身份设为' + roleText + '。\n通过后该账号可以立即登录。'
          : '将「' + d.name + '」的申请标记为已驳回。',
        confirmText: '确认' + (approve ? '通过' : '驳回'),
        confirmColor: approve ? '#2f6df6' : '#ef4444',
        success: (r) => {
          if (r.confirm) doApply(approve, role, note)
        }
      })
    }

    wx.showActionSheet({
      itemList: ['通过 · 设为员工', '通过 · 设为主管', '驳回'],
      success: (res) => {
        if (res.tapIndex === 0) confirmThen(true, 'staff', '')
        else if (res.tapIndex === 1) confirmThen(true, 'manager', '')
        else if (res.tapIndex === 2) {
          wx.showModal({
            title: '驳回「' + d.name + '」的申请',
            editable: true,
            placeholderText: '填写驳回原因（可选）',
            success: (m) => {
              if (m.confirm) confirmThen(false, null, m.content || '')
            }
          })
        }
      }
    })
  }
})

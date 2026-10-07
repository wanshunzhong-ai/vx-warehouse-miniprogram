const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const page = require('../../utils/page')
const roles = require('../../utils/roles')
const auth = require('../../utils/auth')

const PAGE_SIZE = 20

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'in', label: '入库' },
  { key: 'out', label: '出库' },
  { key: 'today', label: '今天' }
]

function decorate(list) {
  list.forEach(function (r) {
    r.timeText = util.formatDateTime(r.created_at).slice(11) || util.fromNow(r.created_at)
    r.isIn = r.type === 'in'
    r.operatorText = r.operator_name || '未署名'
    r.operatorRoleText = r.operator_role ? roles.roleLabel(r.operator_role) : ''
  })
  return list
}

function groupByDate(list) {
  const map = {}
  const order = []
  list.forEach(function (r) {
    const d = util.formatDate(r.created_at) || '未知日期'
    if (!map[d]) {
      map[d] = { date: d, count: 0, items: [] }
      order.push(d)
    }
    const g = map[d]
    // 同日内的入出汇总，方便一眼看清当天动向
    if (r.type === 'in') g.inQty = (g.inQty || 0) + r.qty
    else g.outQty = (g.outQty || 0) + r.qty
    g.items.push(r)
    g.count++
  })
  return order.map(function (d) {
    return map[d]
  })
}

Page({
  data: {
    filters: FILTERS,
    activeKey: 'all',
    groups: [],
    total: 0,
    sumIn: 0,
    sumOut: 0,
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    role: '',
    caps: {}
  },

  onShow() {
    const role = auth.currentRole() || 'staff'
    page.setup(this, {
      tab: 'records',
      title: role === 'admin' ? '全仓出入库记录' : '出入库记录'
    })
    this.reload()
  },

  onPullDownRefresh() {
    this.reload(function () {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom() {
    this.loadMore()
  },

  pickFilter(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeKey) return
    this.setData({ activeKey: key })
    this.reload()
  },

  buildQuery(page) {
    const key = this.data.activeKey
    const q = { page: page, pageSize: PAGE_SIZE }
    if (key === 'in' || key === 'out') q.type = key
    if (key === 'today') q.todayOnly = true
    return q
  },

  async reload(done) {
    const session = await app.ensureLogin()
    if (!session) {
      if (done) done()
      return
    }
    this.setData({ loading: true })
    try {
      const res = await api.listRecords(this.buildQuery(1))
      const list = decorate(res.list || [])
      this.setData({
        groups: groupByDate(list),
        total: res.total || 0,
        sumIn: res.sumIn || 0,
        sumOut: res.sumOut || 0,
        page: 1,
        hasMore: list.length === PAGE_SIZE,
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(util.friendlyError(e))
    }
    if (done) done()
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const next = this.data.page + 1
    this.setData({ loadingMore: true })
    try {
      const res = await api.listRecords(this.buildQuery(next))
      const loaded = []
      this.data.groups.forEach(function (g) {
        g.items.forEach(function (r) {
          loaded.push(r)
        })
      })
      const list = loaded.concat(decorate(res.list || []))
      this.setData({
        groups: groupByDate(list),
        page: next,
        hasMore: (res.list || []).length === PAGE_SIZE,
        loadingMore: false
      })
    } catch (e) {
      this.setData({ loadingMore: false })
      util.toast(util.friendlyError(e))
    }
  },

  onExport() {
    if (!this.data.caps.record_export) {
      util.toast('导出记录需要主管及以上身份')
      return
    }
    wx.showActionSheet({
      itemList: ['复制全部记录（可粘贴到表格）'],
      success: (res) => {
        if (res.tapIndex === 0) this.copyRecords()
      }
    })
  },

  async copyRecords() {
    try {
      util.loading('整理数据')
      const rows = await api.exportRecords()
      util.hideLoading()
      if (!rows.length) {
        util.toast('还没有记录可导出')
        return
      }
      const header = ['时间', '类型', '物品编号', '物品名称', '数量', '变动前', '变动后', '操作人', '备注']
      const lines = [header.join('\t')]
      rows.forEach(function (r) {
        lines.push(
          [
            util.formatDateTime(r.created_at),
            r.type === 'in' ? '入库' : '出库',
            r.item_code,
            r.item_name,
            r.qty,
            r.before_qty,
            r.after_qty,
            r.operator_name || '',
            (r.note || '').replace(/\s+/g, ' ')
          ].join('\t')
        )
      })
      wx.setClipboardData({
        data: lines.join('\n'),
        success: function () {
          wx.showModal({
            title: '已复制',
            content: '共 ' + rows.length + ' 条记录已复制到剪贴板，粘贴到 Excel 或腾讯文档即可查看。',
            showCancel: false
          })
        }
      })
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  }
})

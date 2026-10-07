const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const page = require('../../utils/page')

const PAGE_SIZE = 20
/** 首页「库存预警」下钻时用缓存带参数（switchTab 不支持 query） */
const FILTER_KEY = 'warehouse_items_filter'

Page({
  data: {
    keyword: '',
    category: '',
    categories: [],
    /** 物品状态：active 在用 / archived 已停用 */
    status: 'active',
    /** 只看库存预警（从首页下钻时打开） */
    lowFilter: false,
    list: [],
    total: 0,
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    emptyTitle: '',
    emptyDesc: '',
    role: '',
    caps: {}
  },

  onLoad(options) {
    const opt = options || {}
    const patch = {}
    if (opt.status) patch.status = opt.status
    if (opt.low === '1') patch.lowFilter = true
    if (opt.category) patch.category = decodeURIComponent(opt.category)
    if (Object.keys(patch).length) this.setData(patch)
  },

  onShow() {
    page.setup(this, { tab: 'items', title: '物品档案' })
    // 首页点「库存预警」过来时，筛选条件通过缓存传递
    const bridged = wx.getStorageSync(FILTER_KEY)
    if (bridged) {
      wx.removeStorageSync(FILTER_KEY)
      const patch = {}
      if (bridged.low) {
        patch.lowFilter = true
        patch.status = 'active'
      }
      if (bridged.category) patch.category = bridged.category
      if (Object.keys(patch).length) this.setData(patch)
    }
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

  onReachBottom() {
    this.loadMore()
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this.reload()
    }, 350)
  },

  clearKeyword() {
    this.setData({ keyword: '' })
    this.reload()
  },

  pickCategory(e) {
    const cat = e.currentTarget.dataset.cat || ''
    this.setData({ category: cat === this.data.category ? '' : cat })
    this.reload()
  },

  /** 切换 在用 / 已停用 */
  pickStatus(e) {
    const s = e.currentTarget.dataset.status || 'active'
    if (s === this.data.status && !this.data.lowFilter) return
    // 两个状态下的分类集合不一样，切过去时重新拉一次
    this.setData(
      { status: s, lowFilter: false, category: '', categories: [] },
      () => this.reload()
    )
  },

  clearLowFilter() {
    this.setData({ lowFilter: false }, () => this.reload())
  },

  /** 本地过滤（只用于低库存这种小数据集） */
  _filterLocal(list) {
    const kw = this.data.keyword.trim().toLowerCase()
    const cat = this.data.category
    return (list || []).filter(function (it) {
      if (cat && it.category !== cat) return false
      if (!kw) return true
      return [it.code, it.name, it.spec, it.location].some(function (v) {
        return v && String(v).toLowerCase().indexOf(kw) !== -1
      })
    })
  },

  /** 空态文案（WXML 里写不下这么长的判断，统一在这里算好） */
  _emptyText() {
    if (this.data.lowFilter) {
      return { title: '库存都很充足', desc: '当前没有低于安全库存的物品，暂时不用补货' }
    }
    if (this.data.keyword || this.data.category) {
      return { title: '没有找到匹配的物品', desc: '换个关键词或分类试试' }
    }
    if (this.data.status === 'archived') {
      return { title: '没有已停用的物品', desc: '停用后的物品会出现在这里，随时可以恢复使用' }
    }
    return {
      title: '还没有物品档案',
      desc: this.data.caps.item_create
        ? '点击右下角 + 新建，或用电脑端工具批量导入'
        : '仓库还没有建档，请联系主管或管理员'
    }
  },

  async reload(done) {
    const session = await app.ensureLogin()
    if (!session) {
      if (done) done()
      return
    }

    this.setData({ loading: true })
    try {
      const status = this.data.status
      const low = this.data.lowFilter
      const wantsCategories = this.data.categories.length === 0

      // 低库存走服务端专用函数（已按紧缺程度排序）；其余走常规分页查询
      const listPromise = low
        ? api.lowStockItems(100).then(function (rows) {
            const arr = rows || []
            return { list: arr, count: arr.length }
          })
        : api.listItems({
            keyword: this.data.keyword.trim(),
            category: this.data.category,
            status: status,
            page: 1,
            pageSize: PAGE_SIZE
          })

      const results = await Promise.all([
        listPromise,
        wantsCategories ? api.listCategories(status) : Promise.resolve(this.data.categories)
      ])

      const first = results[0] || { list: [], count: 0 }
      let list = first.list || []
      let count = first.count || 0
      if (low) {
        list = this._filterLocal(list)
        count = list.length
      }

      const empty = this._emptyText()
      this.setData({
        list: util.decorateItems(list),
        total: count,
        categories: results[1] || [],
        page: 1,
        hasMore: !low && list.length === PAGE_SIZE,
        loading: false,
        emptyTitle: empty.title,
        emptyDesc: empty.desc
      })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(util.friendlyError(e))
    }

    if (done) done()
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    if (this.data.lowFilter) return
    const next = this.data.page + 1
    this.setData({ loadingMore: true })

    try {
      const res = await api.listItems({
        keyword: this.data.keyword.trim(),
        category: this.data.category,
        status: this.data.status,
        page: next,
        pageSize: PAGE_SIZE
      })
      this.setData({
        list: this.data.list.concat(util.decorateItems(res.list)),
        page: next,
        hasMore: res.list.length === PAGE_SIZE,
        loadingMore: false
      })
    } catch (e) {
      this.setData({ loadingMore: false })
      util.toast(util.friendlyError(e))
    }
  },

  openItem(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  }
})

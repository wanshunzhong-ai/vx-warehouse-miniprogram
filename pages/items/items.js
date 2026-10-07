const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const page = require('../../utils/page')

const PAGE_SIZE = 20

Page({
  data: {
    keyword: '',
    category: '',
    categories: [],
    list: [],
    total: 0,
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    role: '',
    caps: {}
  },

  onShow() {
    page.setup(this, { tab: 'items', title: '物品档案' })
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

  async reload(done) {
    const session = await app.ensureLogin()
    if (!session) {
      if (done) done()
      return
    }

    this.setData({ loading: true })
    try {
      const wantsCategories = this.data.categories.length === 0
      const results = await Promise.all([
        api.listItems({
          keyword: this.data.keyword.trim(),
          category: this.data.category,
          page: 1,
          pageSize: PAGE_SIZE
        }),
        wantsCategories ? api.listCategories() : Promise.resolve(this.data.categories)
      ])

      const first = results[0] || { list: [], count: 0 }
      this.setData({
        list: first.list,
        total: first.count,
        categories: results[1] || [],
        page: 1,
        hasMore: first.list.length === PAGE_SIZE,
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
      const res = await api.listItems({
        keyword: this.data.keyword.trim(),
        category: this.data.category,
        page: next,
        pageSize: PAGE_SIZE
      })
      this.setData({
        list: this.data.list.concat(res.list),
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

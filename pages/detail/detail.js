const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const qrcodeCanvas = require('../../utils/qrcode-canvas')

Page({
  data: {
    id: null,
    item: null,
    records: [],
    createdText: '',
    loading: true,
    caps: {}
  },

  onLoad(options) {
    const opts = options || {}
    this._id = opts.id ? Number(opts.id) : null
    this._code = opts.code ? decodeURIComponent(opts.code) : ''
    this.setData({ caps: auth.caps() })
    this.load()
  },

  onShow() {
    // 从编辑页返回时刷新
    if (this._loadedOnce) this.load()
  },

  onReady() {
    this._ready = true
    this.drawQr()
  },

  async load() {
    const session = await app.ensureLogin()
    if (!session) return

    this.setData({ loading: true })
    try {
      const item = this._id
        ? await api.getItemById(this._id)
        : await api.getItemByCode(this._code)
      if (!item) {
        this.setData({ item: null, loading: false })
        return
      }
      this._id = item.id
      this.setData({
        item: item,
        createdText: util.formatDateTime(item.created_at),
        loading: false
      })
      this._loadedOnce = true
      this.drawQr()

      const res = await api.listRecords({ itemCode: item.code, pageSize: 20 })
      this.setData({ records: util.decorateRecords((res && res.list) || []) })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(util.friendlyError(e))
    }
  },

  drawQr() {
    if (!this._ready || !this.data.item) return
    const code = this.data.item.code
    if (this._drawnCode === code) return

    wx.createSelectorQuery()
      .in(this)
      .select('#qr-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0]
        if (!info || !info.node) return
        try {
          const size = Math.round(info.width) || 190
          qrcodeCanvas.draw(info.node, size, code)
          this._canvasNode = info.node
          this._qrSize = size
          this._drawnCode = code
        } catch (e) {
          console.error('[warehouse] qr draw failed', JSON.stringify({ message: e && e.message }))
        }
      })
  },

  async saveQr() {
    if (!this._canvasNode) {
      util.toast('二维码还在生成，请稍候')
      return
    }
    try {
      util.loading('生成图片')
      const path = await qrcodeCanvas.toTempFilePath(this._canvasNode, this._qrSize, this)
      util.hideLoading()

      await new Promise(function (resolve, reject) {
        wx.saveImageToPhotosAlbum({ filePath: path, success: resolve, fail: reject })
      })
      util.toast('已保存到相册', 'success')
    } catch (e) {
      util.hideLoading()
      const msg = (e && (e.errMsg || e.message)) || ''
      if (msg.indexOf('auth deny') !== -1 || msg.indexOf('authorize') !== -1 || msg.indexOf('authDeny') !== -1) {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中允许「保存到相册」，才能保存二维码图片。',
          confirmText: '去设置',
          success: function (r) {
            if (r.confirm) wx.openSetting()
          }
        })
        return
      }
      util.toast('保存失败，请重试')
    }
  },

  copyCode() {
    if (!this.data.item) return
    wx.setClipboardData({ data: this.data.item.code })
  },

  goIn() {
    this.goStock('in')
  },

  goOut() {
    this.goStock('out')
  },

  goStock(type) {
    wx.navigateTo({
      url: '/pages/stock/stock?type=' + type + '&code=' + encodeURIComponent(this.data.item.code)
    })
  },

  goEdit() {
    if (!this.data.caps.item_edit) {
      util.toast('编辑档案需要主管及以上身份')
      return
    }
    wx.navigateTo({ url: '/pages/edit/edit?id=' + this.data.item.id })
  },

  onDelete() {
    if (!this.data.caps.item_delete) {
      util.toast('删除物品只有管理员可以操作')
      return
    }
    const item = this.data.item
    wx.showModal({
      title: '删除物品',
      content: '将删除「' + item.name + '」的档案，历史出入库记录会保留。此操作不可撤销。',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          util.loading('删除中')
          await api.deleteItem(item.id)
          util.hideLoading()
          util.toast('已删除', 'success')
          setTimeout(function () {
            wx.navigateBack({ delta: 1 })
          }, 600)
        } catch (e) {
          util.hideLoading()
          util.toast(util.friendlyError(e))
        }
      }
    })
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: function () {
        wx.switchTab({ url: '/pages/items/items' })
      }
    })
  }
})

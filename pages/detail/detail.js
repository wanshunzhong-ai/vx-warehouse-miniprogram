const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const qrcodeCanvas = require('../../utils/qrcode-canvas')
const photo = require('../../utils/photo')

Page({
  data: {
    id: null,
    item: null,
    records: [],
    createdText: '',
    loading: true,
    caps: {},
    /** 位置照片的签名链接（会过期，每次进页面现取） */
    photoUrl: '',
    photoLoading: false,
    /** 照片拍摄时间（从对象路径里的时间戳还原，用来看这张图是不是过时了） */
    photoTimeText: ''
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
        item: util.decorateItem(item),
        createdText: util.formatDateTime(item.created_at),
        // 有照片时先亮加载态，否则第一帧会闪一下「还没拍位置照片」
        photoLoading: !!item.photo,
        loading: false
      })
      this._loadedOnce = true
      this.drawQr()
      this.loadPhoto(item)

      const res = await api.listRecords({ itemCode: item.code, pageSize: 20 })
      this.setData({ records: util.decorateRecords((res && res.list) || []) })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(util.friendlyError(e))
    }
  },

  /**
   * 取位置照片：数据库里存的是对象路径，链接是现换的短期签名地址。
   * 换链接失败（比如网络抖动）不该把整个详情页带崩，所以单独 try。
   */
  async loadPhoto(item) {
    if (!item || !item.photo) {
      this.setData({ photoUrl: '', photoLoading: false, photoTimeText: '' })
      return
    }
    if (this._photoPath === item.photo && this.data.photoUrl) {
      // 同一个对象路径、链接还在缓存里，直接用；但要把加载态收掉
      this.setData({ photoLoading: false })
      return
    }

    this.setData({ photoLoading: true })
    try {
      const url = await photo.signUrl(item.photo)
      this._photoPath = item.photo
      this.setData({
        photoUrl: url,
        photoLoading: false,
        photoTimeText: this.photoTimeText(item.photo)
      })
    } catch (e) {
      this.setData({ photoUrl: '', photoLoading: false, photoTimeText: '' })
      console.error('[warehouse] photo url failed', JSON.stringify({ message: e && e.message }))
    }
  },

  /** 从对象路径 shared/<uid>/items/<物品id>-<时间戳>.jpg 里还原拍摄时间 */
  photoTimeText(path) {
    const m = /-(\d{10,})\.[a-z]+$/i.exec(String(path || ''))
    if (!m) return ''
    const ts = Number(m[1])
    if (!ts) return ''
    return util.fromNow(new Date(ts).toISOString())
  },

  /** 拍照 / 选图上传（换照片走同一个入口） */
  async onPhoto() {
    if (!this.data.caps.item_photo) {
      util.toast('当前身份不能上传照片')
      return
    }
    const item = this.data.item
    if (!item) return

    let tempPath = ''
    try {
      tempPath = await photo.choosePhoto()
    } catch (e) {
      const msg = (e && e.message) || ''
      if (msg === 'CANCELED') return
      if (msg === 'PHOTO_PERMISSION_DENIED') {
        wx.showModal({
          title: '需要相机/相册权限',
          content: '请在设置中允许使用相机或相册，才能给物品拍位置照片。',
          confirmText: '去设置',
          success: function (r) {
            if (r.confirm) wx.openSetting()
          }
        })
        return
      }
      util.toast(util.friendlyError(e))
      return
    }

    const oldPath = item.photo
    try {
      util.loading(this.data.photoUrl ? '更换中' : '上传中')
      const path = await photo.upload(item.id, tempPath)
      await api.setItemPhoto(item.id, path)
      util.hideLoading()
      util.toast('位置照片已保存', 'success')
      // 换掉旧图：只有自己上传的能删，删不掉也不影响（数据库已经指向新图）
      if (oldPath && oldPath !== path) photo.remove(oldPath)
      this._photoPath = ''
      this.load()
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  /** 删除位置照片（只是不再关联，档案本身不动） */
  onRemovePhoto() {
    if (!this.data.caps.item_photo) {
      util.toast('当前身份不能修改照片')
      return
    }
    const item = this.data.item
    if (!item || !item.photo) return

    wx.showModal({
      title: '删除位置照片',
      content: '只是不再显示这张照片，不影响物品档案与出入库记录。',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        const oldPath = item.photo
        try {
          util.loading('删除中')
          await api.setItemPhoto(item.id, null)
          util.hideLoading()
          util.toast('已删除', 'success')
          photo.remove(oldPath)
          this._photoPath = ''
          this.load()
        } catch (e) {
          util.hideLoading()
          util.toast(util.friendlyError(e))
        }
      }
    })
  },

  /** 点开看大图（可以顺手放大看货架细节） */
  previewPhoto() {
    const url = this.data.photoUrl
    if (!url) return
    wx.previewImage({
      urls: [url],
      current: url,
      fail: function () {
        util.toast('打开大图失败，请重试')
      }
    })
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
    if (!this.data.caps.stock_change) {
      util.toast('管理员不参与出入库，请由主管或员工操作')
      return
    }
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

  /** 停用 / 恢复：停用后不参与出入库，但档案与历史记录都在 */
  onToggleArchive() {
    if (!this.data.caps.item_archive) {
      util.toast('停用物品需要主管及以上身份')
      return
    }
    const item = this.data.item
    const archiving = !item.isArchived
    wx.showModal({
      title: archiving ? '停用物品' : '恢复使用',
      content: archiving
        ? '停用后「' + item.name + '」不能再出入库，档案与历史记录都会保留，之后随时可以恢复。'
        : '恢复后「' + item.name + '」重新可以出入库。',
      confirmText: archiving ? '停用' : '恢复',
      success: async (res) => {
        if (!res.confirm) return
        try {
          util.loading(archiving ? '停用中' : '恢复中')
          await api.archiveItem(item.id, archiving)
          util.hideLoading()
          util.toast(archiving ? '已停用' : '已恢复使用', 'success')
          this.load()
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

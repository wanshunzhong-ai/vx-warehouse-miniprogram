const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')

function normalize(raw) {
  let code = String(raw == null ? '' : raw).trim()
  if (!code) return ''
  if (/^https?:\/\//i.test(code)) {
    const m = code.match(/[?&](?:code|id)=([^&#]+)/i)
    code = m ? decodeURIComponent(m[1]) : code
  }
  return code.slice(0, 106)
}

Page({
  data: {
    code: '',
    codeInput: '',
    manual: false,
    loading: true,
    item: null,
    type: 'in',
    qtyText: '1',
    note: '',
    operatorName: '',
    roleLabel: '',
    submitting: false,
    result: null,
    caps: {}
  },

  onLoad(options) {
    const opts = options || {}
    const code = normalize(decodeURIComponent(opts.code || ''))
    const type = opts.type === 'out' ? 'out' : 'in'
    this.setData({
      code: code,
      codeInput: code,
      type: type,
      manual: !code,
      loading: !!code,
      operatorName: auth.getOperatorName(),
      roleLabel: require('../../utils/roles').label(auth.currentRole()),
      caps: auth.caps()
    })
    this._skipNextShow = true
    if (code) this.load()
  },

  onShow() {
    if (this._skipNextShow) {
      this._skipNextShow = false
      return
    }
    // 从「建档 / 详情」返回时刷新库存
    if (this.data.code) this.load()
  },

  async load() {
    const me = await app.ensureLogin()
    if (!me) return
    this.setData({ loading: true })
    try {
      const item = await api.getItemByCode(this.data.code)
      this.setData({ item: item || null, loading: false })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(util.friendlyError(e))
    }
  },

  /* ---------------- 手动输入编号 ---------------- */

  onCodeInput(e) {
    this.setData({ codeInput: e.detail.value })
  },

  onCodeConfirm() {
    const code = normalize(this.data.codeInput)
    if (!code) {
      util.toast('请输入物品编号')
      return
    }
    this.setData({ code: code, result: null })
    this.load()
  },

  scanCode() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode', 'datamatrix', 'pdf417'],
      success: (res) => {
        const code = normalize(res.result)
        if (!code) {
          util.toast('没识别到有效编号')
          return
        }
        this.setData({ code: code, codeInput: code, result: null })
        this.load()
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') === -1) util.toast('扫码失败，可手动输入编号')
      }
    })
  },

  /* ---------------- 表单 ---------------- */

  switchType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
  },

  onQtyInput(e) {
    this.setData({ qtyText: e.detail.value })
  },

  onQtyBlur() {
    const n = parseInt(this.data.qtyText, 10)
    this.setData({ qtyText: isNaN(n) || n < 1 ? '1' : String(n) })
  },

  minusOne() {
    const n = parseInt(this.data.qtyText, 10) || 1
    this.setData({ qtyText: String(Math.max(1, n - 1)) })
  },

  plusOne() {
    const n = parseInt(this.data.qtyText, 10) || 0
    this.setData({ qtyText: String(n + 1) })
  },

  setQty(e) {
    this.setData({ qtyText: String(e.currentTarget.dataset.v) })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  async submit() {
    if (this.data.submitting || !this.data.item) return

    const qty = parseInt(this.data.qtyText, 10)
    if (isNaN(qty) || qty <= 0) {
      util.toast('请输入大于 0 的数量')
      return
    }
    if (this.data.type === 'out' && qty > this.data.item.qty) {
      util.toast('出库数量不能超过当前库存 ' + this.data.item.qty)
      return
    }

    this.setData({ submitting: true })
    const before = this.data.item.qty
    try {
      // 操作人由服务端按登录身份写入，不用手填
      const res = await api.changeStock(this.data.code, this.data.type, qty, this.data.note.trim())
      const updated = res.item
      require('../../utils/recent').push({ code: updated.code, name: updated.name })
      this.setData({
        submitting: false,
        item: updated,
        result: {
          type: this.data.type,
          qty: qty,
          before: before,
          after: updated.qty,
          operator: (res.record && res.record.operator_name) || auth.getOperatorName()
        }
      })
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
    } catch (e) {
      this.setData({ submitting: false })
      util.toast(util.friendlyError(e))
    }
  },

  resetForm() {
    this.setData({ result: null, qtyText: '1', note: '' })
  },

  goCreate() {
    if (!this.data.caps.item_create) {
      util.toast('建档需要主管及以上身份')
      return
    }
    wx.navigateTo({ url: '/pages/edit/edit?code=' + encodeURIComponent(this.data.code) })
  },

  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.item.id })
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: function () {
        wx.switchTab({ url: '/pages/index/index' })
      }
    })
  }
})

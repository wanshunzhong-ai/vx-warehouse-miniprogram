const app = getApp()
const util = require('../../utils/util')
const recentStore = require('../../utils/recent')
const page = require('../../utils/page')

/** 扫码结果可能带空白或链接，统一取出物品编号 */
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
    manualCode: '',
    recent: []
  },

  onShow() {
    page.setup(this, { tab: 'scan', title: '扫码出入库' })
    this.loadRecent()
  },

  loadRecent() {
    const rows = recentStore.list()
    rows.forEach(function (r) {
      r.timeText = util.fromNow(new Date(r.at).toISOString())
      r.initial = r.name ? String(r.name).slice(0, 1) : '?'
    })
    this.setData({ recent: rows })
  },

  onInput(e) {
    this.setData({ manualCode: e.detail.value })
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode', 'datamatrix', 'pdf417'],
      success: (res) => {
        const code = normalize(res.result)
        if (!code) {
          util.toast('没识别到有效编号，请重试')
          return
        }
        this.openStock(code)
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') !== -1) return
        util.toast('扫码失败，可试试手动输入编号')
      }
    })
  },

  onManualSearch() {
    const code = normalize(this.data.manualCode)
    if (!code) {
      util.toast('请输入物品编号')
      return
    }
    this.openStock(code)
  },

  openRecent(e) {
    this.openStock(e.currentTarget.dataset.code)
  },

  openStock(code) {
    this.setData({ manualCode: '' })
    wx.navigateTo({ url: '/pages/stock/stock?code=' + encodeURIComponent(code) })
  },

  clearRecent() {
    wx.showModal({
      title: '清空最近扫描',
      content: '只清空本机的历史记录，不影响仓库数据。',
      success: (res) => {
        if (!res.confirm) return
        recentStore.clear()
        this.setData({ recent: [] })
      }
    })
  }
})

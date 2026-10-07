const app = getApp()
const util = require('../../utils/util')
const recentStore = require('../../utils/recent')
const page = require('../../utils/page')

/** 与 pages/index/index.js 约定同一份缓存键：工作台点方向后直达扫码 */
const SCAN_DIR_KEY = 'warehouse_scan_dir'

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
    /** 手动输入时选的方向，默认入库 */
    manualType: 'in',
    recent: []
  },

  onShow() {
    page.setup(this, { tab: 'scan', title: '扫码出入库' })
    this.loadRecent()

    // 工作台点「扫码入库 / 扫码出库」时会把方向存在这里，一次性消费后立刻拉起扫码
    const dir = wx.getStorageSync(SCAN_DIR_KEY)
    if (dir === 'in' || dir === 'out') {
      wx.removeStorageSync(SCAN_DIR_KEY)
      this.setData({ manualType: dir })
      this.doScan(dir)
    }
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

  /**
   * 入库、出库是两个独立方向：点哪个大按钮就按哪个方向扫。
   * 方向会一路带到数量页并锁定，避免扫完还要再选一次。
   */
  onScan(e) {
    const type = e.currentTarget.dataset.type === 'out' ? 'out' : 'in'
    this.doScan(type)
  },

  doScan(type) {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode', 'datamatrix', 'pdf417'],
      success: (res) => {
        const code = normalize(res.result)
        if (!code) {
          util.toast('没识别到有效编号，请重试')
          return
        }
        this.openStock(code, type)
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') !== -1) return
        util.toast('扫码失败，可试试手动输入编号')
      }
    })
  },

  pickManualType(e) {
    this.setData({ manualType: e.currentTarget.dataset.type === 'out' ? 'out' : 'in' })
  },

  onManualSearch() {
    const code = normalize(this.data.manualCode)
    if (!code) {
      util.toast('请输入物品编号')
      return
    }
    this.openStock(code, this.data.manualType)
  },

  /** 从「最近扫描」重进时方向未知，交给数量页自己选 */
  openRecent(e) {
    this.openStock(e.currentTarget.dataset.code, '')
  },

  openStock(code, type) {
    this.setData({ manualCode: '' })
    let url = '/pages/stock/stock?code=' + encodeURIComponent(code)
    if (type === 'in' || type === 'out') url += '&type=' + type
    wx.navigateTo({ url: url })
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

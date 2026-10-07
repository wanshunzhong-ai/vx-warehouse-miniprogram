const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const page = require('../../utils/page')

const SAMPLE =
  '编号\t名称\t规格\t类别\t单位\t位置\t库存\t安全库存\t备注\n' +
  'A-001\t不锈钢螺丝\tM6x20\t五金\t个\tA区-1排\t200\t50\t常用件\n' +
  'A-002\t橡胶垫片\tDN50\t密封件\t片\tA区-2排\t80\t30\t\n' +
  '\t内六角扳手\t5mm\t工具\t把\t工具柜\t6\t2\t编号留空会自动生成'

Page({
  data: {
    raw: '',
    rows: [],
    preview: [],
    errors: [],
    importing: false,
    progress: ''
  },

  onLoad() {
    if (!page.guard('item.import')) return
    app.ensureLogin()
  },

  onRawInput(e) {
    this.setData({ raw: e.detail.value })
  },

  fillSample() {
    this.setData({ raw: SAMPLE })
    this.parse()
  },

  pasteFromClipboard() {
    wx.getClipboardData({
      success: (res) => {
        if (!res.data || !String(res.data).trim()) {
          util.toast('剪贴板是空的')
          return
        }
        this.setData({ raw: res.data })
        this.parse()
      },
      fail: () => util.toast('读取剪贴板失败')
    })
  },

  parse() {
    const parsed = util.parseSheet(this.data.raw)
    this.setData({
      rows: parsed.rows,
      preview: parsed.rows.slice(0, 8),
      errors: parsed.errors
    })
    if (!parsed.rows.length) util.toast('没有解析到有效数据')
  },

  async doImport() {
    if (this.data.importing) return
    const rows = this.data.rows.slice()
    if (!rows.length) return

    // 编号查重，避免中途才发现冲突
    const seen = {}
    for (let i = 0; i < rows.length; i++) {
      const c = (rows[i].code || '').trim()
      if (!c) continue
      if (seen[c]) {
        util.toast('第 ' + (i + 1) + ' 行的编号「' + c + '」在前面出现过')
        return
      }
      seen[c] = true
    }

    this.setData({ importing: true, progress: '正在导入 ' + rows.length + ' 条…', errors: [] })

    try {
      // 整批交给服务端一次处理：编号留空由服务端生成，
      // 初始库存会同步写成一条入库流水
      const res = await api.importItems(rows, [])
      const inserted = (res && res.inserted) || 0
      const failed = (res && res.failed) || 0
      const list = (res && res.errors) || []

      try {
        wx.vibrateShort({ type: 'light' })
      } catch (e) {
        // 忽略
      }

      this.setData({ importing: false, progress: '', errors: list })

      if (failed === 0) {
        wx.showModal({
          title: '导入完成',
          content: '成功导入 ' + inserted + ' 个物品。',
          showCancel: false,
          success: () => wx.navigateBack({ delta: 1 })
        })
      } else {
        wx.showModal({
          title: '部分导入成功',
          content: '成功 ' + inserted + ' 个，失败 ' + failed + ' 个。失败原因见下方列表。',
          showCancel: false
        })
      }
    } catch (e) {
      this.setData({ importing: false, progress: '' })
      util.toast(util.friendlyError(e))
    }
  }
})

const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const page = require('../../utils/page')

/** 按角色列出手里能做的事，写在「我的」里让人一眼看清权限边界 */
const ABILITY = {
  admin: [
    '审批员工账号、调整任何人身份',
    '启用 / 停用账号、重置密码',
    '新建与删除物品、批量导入',
    '全仓出入库记录与导出'
  ],
  manager: [
    '添加员工账号（提交后由管理员审批）',
    '新建 / 编辑物品、批量导入',
    '扫码出入库、查看全仓记录与导出'
  ],
  staff: [
    '扫码出入库、手动输入编号',
    '查询物品档案与实时库存',
    '查看出入库记录'
  ]
}

Page({
  data: {
    role: '',
    caps: {},
    me: {},
    stat: {},
    overview: {},
    ability: [],
    isAdmin: false
  },

  onShow() {
    page.setup(this, { tab: 'my', title: '我的' })
    this.load()
  },

  async load() {
    const session = await app.ensureLogin()
    if (!session) return

    const role = session.role
    const isAdmin = role === 'admin'
    this.setData({
      me: util.decorateStaff(Object.assign({}, session)),
      ability: ABILITY[role] || ABILITY.staff,
      isAdmin: isAdmin
    })

    try {
      const jobs = [api.stats(role === 'staff' ? 'mine' : 'all')]
      jobs.push(role === 'staff' ? Promise.resolve(null) : api.staffOverview())
      const res = await Promise.all(jobs)
      this.setData({
        stat: res[0] || {},
        overview: res[1] || {}
      })
    } catch (e) {
      // 概览失败不阻塞页面
    }
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  goStaff(e) {
    const status = (e && e.currentTarget && e.currentTarget.dataset.status) || ''
    wx.navigateTo({ url: '/pages/staff/staff' + (status ? '?status=' + status : '') })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  async exportItems() {
    if (!this.data.caps.record_export) {
      util.toast('导出清单需要主管及以上身份')
      return
    }
    try {
      util.loading('整理数据')
      const rows = await api.exportItems()
      util.hideLoading()
      if (!rows.length) {
        util.toast('还没有物品可导出')
        return
      }
      const header = ['编号', '名称', '规格', '类别', '单位', '位置', '库存', '安全库存', '备注']
      const lines = [header.join('\t')]
      rows.forEach(function (r) {
        lines.push(
          [
            r.code,
            r.name,
            r.spec || '',
            r.category || '',
            r.unit || '',
            r.location || '',
            r.qty,
            r.min_qty,
            (r.note || '').replace(/\s+/g, ' ')
          ].join('\t')
        )
      })
      wx.setClipboardData({
        data: lines.join('\n'),
        success: function () {
          wx.showModal({
            title: '已复制',
            content: '共 ' + rows.length + ' 个物品已复制到剪贴板，可直接粘贴到 Excel 或腾讯文档。',
            showCancel: false
          })
        }
      })
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  showPcTip() {
    wx.showModal({
      title: '电脑端标签打印工具',
      content:
        '在电脑上用浏览器打开项目里的 pc-tools/index.html：\n\n' +
        '1. 粘贴或从 Excel 复制物品清单\n' +
        '2. 一键生成编号和二维码标签\n' +
        '3. 直接打印 A4 标签纸，或导出 CSV 后再到小程序「批量导入」\n\n' +
        '二维码内容就是物品编号，和手机扫码完全对应。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  onSignOut() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新输入账号密码。',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        await auth.signOut()
        wx.reLaunch({ url: '/pages/login/login' })
      }
    })
  }
})

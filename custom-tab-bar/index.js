const roles = require('../utils/roles')

/**
 * 自定义 tabBar
 *
 * 页签集合和主色都跟着当前登录角色走：
 *   管理员 → 管理中心 / 物品 / 全仓记录 / 我的
 *   主管   → 主管台 / 物品 / 扫码 / 记录 / 我的
 *   员工   → 工作台 / 物品 / 扫码(凸起) / 记录 / 我的
 *
 * 员工的核心工作就是扫码，所以它的「扫码」是正中间那个凸起的圆形大按钮，
 * 与普通页签区分开（见 utils/roles.js 的 RAISED_TAB）。
 *
 * 页面在 onShow 里调用 utils/tabbar.js 的 sync() 写入 list 与 selected。
 */
Component({
  data: {
    selected: 0,
    theme: 'theme-staff',
    hasRaised: roles.hasRaised('staff'),
    list: roles.tabBar('staff')
  },

  methods: {
    onTap(e) {
      const index = e.currentTarget.dataset.index
      const target = this.data.list[index]
      if (!target || index === this.data.selected) return
      wx.switchTab({ url: target.pagePath })
    }
  }
})

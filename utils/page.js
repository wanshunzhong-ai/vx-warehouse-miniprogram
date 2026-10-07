/**
 * 页面通用装配
 *
 * 每个页面 onShow 里调用 setup(this, { tab, title })，一次性把
 * 当前角色、能力标记、tabBar 选中态和导航标题都对齐，
 * 免得到处散落重复代码。
 */
const auth = require('./auth')
const roles = require('./roles')
const tabbar = require('./tabbar')

function setup(page, opts) {
  const o = opts || {}
  if (o.tab) tabbar.sync(page, o.tab)

  const role = auth.currentRole() || 'staff'
  const meta = roles.info(role)

  if (o.title) {
    wx.setNavigationBarTitle({ title: o.title })
  } else if (o.useHomeTitle) {
    wx.setNavigationBarTitle({ title: meta.homeTitle })
  }

  const patch = {
    role: role,
    roleMeta: meta,
    me: auth.currentProfile() || {},
    caps: roles.caps(role)
  }
  page.setData(patch)
  return patch
}

/**
 * 进入页面前的能力校验。
 * 无权限时提示并返回，调用方直接 return。
 */
function guard(cap, tip) {
  if (auth.can(cap)) return true
  wx.showModal({
    title: '没有权限',
    content: tip || '当前身份不能进行该操作，请联系管理员。',
    showCancel: false,
    confirmText: '知道了',
    complete: function () {
      const pages = getCurrentPages()
      if (pages.length > 1) wx.navigateBack()
      else wx.switchTab({ url: '/pages/index/index' })
    }
  })
  return false
}

module.exports = {
  setup: setup,
  guard: guard
}

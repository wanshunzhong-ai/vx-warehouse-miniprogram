/**
 * tabBar 同步
 *
 * 每个 tab 页在 onShow 里调用 sync(this, '工作台 key')，
 * 组件会按当前角色换成对应的页签集合与主色，并高亮当前页。
 */
const roles = require('./roles')
const auth = require('./auth')

function sync(page, key) {
  if (!page || typeof page.getTabBar !== 'function') return
  const bar = page.getTabBar()
  if (!bar) return

  const role = auth.currentRole() || 'staff'
  const list = roles.tabBar(role)
  const idx = roles.tabIndex(role, key)

  bar.setData({
    list: list,
    // -1 表示当前页不在这个角色的导航里（例如管理员进入扫码页），此时不高亮任何一项
    selected: idx,
    theme: 'theme-' + role,
    // 员工导航里有凸起大按钮，需要给底板留出更高的空间
    hasRaised: roles.hasRaised(role)
  })
}

module.exports = {
  sync: sync
}

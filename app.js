const auth = require('./utils/auth')
const session = require('./utils/session')

App({
  globalData: {
    /** 当前登录的员工账号（含 role） */
    staff: null,
    /** 快捷取角色：admin / manager / staff */
    role: '',
    systemInfo: null
  },

  onLaunch() {
    // 策略：每次打开小程序都要重新登录。登录态只活在内存里，
    // 冷启动（onLaunch 每次都会跑）时再显式清一次，
    // 这样「必登录」不依赖 session.js 的实现细节，避免日后被改回去。
    session.clear()

    try {
      this.globalData.systemInfo = wx.getWindowInfo
        ? { windowInfo: wx.getWindowInfo(), deviceInfo: wx.getDeviceInfo() }
        : wx.getSystemInfoSync()
    } catch (e) {
      this.globalData.systemInfo = null
    }
  },

  /** 页面里统一用它确认登录态；未登录会跳登录页并返回 null */
  ensureLogin() {
    return auth.requireSession()
  }
})

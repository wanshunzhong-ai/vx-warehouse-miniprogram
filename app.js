const auth = require('./utils/auth')

App({
  globalData: {
    /** 当前登录的员工账号（含 role） */
    staff: null,
    /** 快捷取角色：admin / manager / staff */
    role: '',
    systemInfo: null
  },

  onLaunch() {
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

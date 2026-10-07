const auth = require('../../utils/auth')
const util = require('../../utils/util')
const roles = require('../../utils/roles')

Page({
  data: {
    username: '',
    password: '',
    showPassword: false,
    canSubmit: false,
    loading: false,
    checking: true,
    error: ''
  },

  onLoad() {
    // 上次用过的账号，方便连续登录
    try {
      const last = wx.getStorageSync('warehouse_last_username')
      if (last) this.setData({ username: last, canSubmit: !!last })
    } catch (e) {
      // 忽略
    }
    this.autoEnter()
  },

  /** 已经登录过就直接进对应的后台，不用再输一次 */
  async autoEnter() {
    try {
      const me = await auth.restore()
      if (me) {
        this.enter(me)
        return
      }
    } catch (e) {
      // 交给用户手动登录
    }
    this.setData({ checking: false })
  },

  enter(staff) {
    if (staff && staff.must_change_password) {
      wx.redirectTo({ url: '/pages/profile/profile?force=1' })
      return
    }
    wx.reLaunch({ url: auth.homeUrl(staff && staff.role) })
  },

  onUsernameInput(e) {
    const v = e.detail.value
    this.setData({ username: v, canSubmit: !!v && !!this.data.password, error: '' })
  },

  onPasswordInput(e) {
    const v = e.detail.value
    this.setData({ password: v, canSubmit: !!v && !!this.data.username, error: '' })
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword })
  },

  async onLogin() {
    if (this.data.loading) return
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username) {
      this.setData({ error: '请输入登录账号' })
      return
    }
    if (!password) {
      this.setData({ error: '请输入密码' })
      return
    }

    this.setData({ loading: true, error: '' })
    try {
      const staff = await auth.login(username, password)
      try {
        wx.setStorageSync('warehouse_last_username', username)
      } catch (e) {
        // 忽略
      }
      this.setData({ loading: false })
      wx.showToast({
        title: roles.label(staff.role) + ' ' + (staff.name || '') + '，欢迎回来',
        icon: 'none',
        duration: 1500
      })
      setTimeout(() => {
        this.enter(staff)
      }, 600)
    } catch (e) {
      this.setData({ loading: false, error: util.friendlyError(e) })
    }
  }
})

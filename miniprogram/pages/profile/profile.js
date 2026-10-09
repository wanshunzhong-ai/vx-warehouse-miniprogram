const util = require('../../utils/util')
const auth = require('../../utils/auth')

Page({
  data: {
    force: false,
    me: {},
    form: { name: '', phone: '', dept: '' },
    pwd: { old: '', new1: '', new2: '' },
    savingProfile: false,
    savingPwd: false,
    errorText: '',
    pwdError: ''
  },

  onLoad(options) {
    const force = !!(options && options.force === '1')
    const me = auth.currentProfile()
    if (!me) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const d = util.decorateStaff(Object.assign({}, me))
    this.setData({
      force: force,
      me: d,
      'form.name': d.name || '',
      'form.phone': d.phone || '',
      'form.dept': d.dept || ''
    })
    if (force) {
      wx.setNavigationBarTitle({ title: '请修改初始密码' })
      wx.showModal({
        title: '首次登录请修改密码',
        content: '你的账号还在使用管理员设置的初始密码，为了安全请先改成只有你知道的密码。',
        showCancel: false,
        confirmText: '知道了'
      })
    }
  },

  onShow() {
    const me = auth.currentProfile()
    if (me) this.setData({ me: util.decorateStaff(Object.assign({}, me)) })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['form.' + key] = e.detail.value
    this.setData(patch)
  },

  onPwdInput(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch['pwd.' + key] = e.detail.value
    this.setData(patch)
  },

  async saveProfile() {
    if (this.data.savingProfile) return
    const f = this.data.form
    const name = String(f.name || '').trim()
    if (!name) {
      this.setData({ errorText: '请填写姓名' })
      return
    }
    this.setData({ savingProfile: true, errorText: '' })
    try {
      const updated = await auth.updateProfile(name, f.phone, f.dept)
      this.setData({
        savingProfile: false,
        me: util.decorateStaff(Object.assign({}, updated))
      })
      util.toast('已保存', 'success')
    } catch (e) {
      this.setData({ savingProfile: false, errorText: util.friendlyError(e) })
    }
  },

  async changePassword() {
    if (this.data.savingPwd) return
    const p = this.data.pwd
    const oldPwd = String(p.old || '')
    const newPwd = String(p.new1 || '')
    const again = String(p.new2 || '')

    if (!oldPwd) {
      this.setData({ pwdError: '请输入当前密码' })
      return
    }
    if (newPwd.length < 6) {
      this.setData({ pwdError: '新密码至少 6 位' })
      return
    }
    if (newPwd !== again) {
      this.setData({ pwdError: '两次输入的新密码不一致' })
      return
    }

    this.setData({ savingPwd: true, pwdError: '' })
    try {
      await auth.changePassword(oldPwd, newPwd)
      this.setData({
        savingPwd: false,
        pwd: { old: '', new1: '', new2: '' },
        force: false,
        me: util.decorateStaff(Object.assign({}, auth.currentProfile()))
      })
      wx.setNavigationBarTitle({ title: '账号与安全' })
      wx.showModal({
        title: '密码已修改',
        content: '其他设备上的登录已经失效，请用新密码重新登录。',
        showCancel: false,
        success: () => {
          wx.reLaunch({ url: '/pages/index/index' })
        }
      })
    } catch (e) {
      this.setData({ savingPwd: false, pwdError: util.friendlyError(e) })
    }
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

const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const page = require('../../utils/page')
const roles = require('../../utils/roles')

const ROLE_OPTIONS = [
  { key: 'staff', label: '员工', desc: '扫码出入库、查库存' },
  { key: 'manager', label: '主管', desc: '可添加员工、建档、导入' },
  { key: 'admin', label: '管理员', desc: '全部权限，含审批与删除' }
]

Page({
  data: {
    mode: 'add',
    isAdmin: false,
    roleOptions: ROLE_OPTIONS,
    form: {
      username: '',
      name: '',
      phone: '',
      dept: '',
      role: 'staff',
      password: '',
      remark: ''
    },
    detail: null,
    newRole: 'staff',
    reviewNote: '',
    resetPwd: '',
    saving: false,
    errorText: ''
  },

  onLoad(options) {
    const opts = options || {}
    const isAdmin = auth.currentRole() === 'admin'
    this.setData({ isAdmin: isAdmin })

    if (opts.id) {
      this._id = Number(opts.id)
      this.setData({ mode: 'detail' })
      wx.setNavigationBarTitle({ title: '账号详情' })
      this.load()
    } else {
      if (!page.guard('staff.add')) return
      this.setData({ mode: 'add', 'form.role': isAdmin ? 'staff' : 'staff' })
      wx.setNavigationBarTitle({
        title: isAdmin ? '创建账号' : '添加员工账号'
      })
    }
  },

  onShow() {
    if (this.data.mode === 'detail' && this._loadedOnce) this.load()
  },

  async load() {
    const me = await app.ensureLogin()
    if (!me) return
    try {
      const rows = await api.listStaff({ status: 'all' })
      const found = (rows || []).filter(function (r) {
        return Number(r.id) === Number(this._id)
      }, this)[0]
      if (!found) {
        util.toast('账号不存在或无权查看')
        setTimeout(function () {
          wx.navigateBack({ delta: 1 })
        }, 800)
        return
      }
      const d = util.decorateStaff(found)
      this._loadedOnce = true
      this.setData({ detail: d, newRole: d.role, reviewNote: '' })
    } catch (e) {
      util.toast(util.friendlyError(e))
    }
  },

  /* ---------------- 表单 ---------------- */

  onInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch['form.' + key] = e.detail.value
    this.setData(patch)
  },

  pickRole(e) {
    this.setData({ 'form.role': e.currentTarget.dataset.role, errorText: '' })
  },

  pickNewRole(e) {
    this.setData({ newRole: e.currentTarget.dataset.role })
  },

  onResetPwdInput(e) {
    this.setData({ resetPwd: e.detail.value })
  },

  onReviewNoteInput(e) {
    this.setData({ reviewNote: e.detail.value })
  },

  /* ---------------- 添加账号 ---------------- */

  async onSave() {
    if (this.data.saving) return
    const f = this.data.form
    const username = String(f.username || '').trim()
    const name = String(f.name || '').trim()

    if (!username) {
      this.setData({ errorText: '请填写登录账号' })
      return
    }
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
      this.setData({ errorText: '登录账号只能是 3-24 位字母、数字、下划线、点或横线' })
      return
    }
    if (!name) {
      this.setData({ errorText: '请填写姓名' })
      return
    }
    const pwd = String(f.password || '').trim()
    if (pwd && pwd.length < 6) {
      this.setData({ errorText: '密码至少 6 位' })
      return
    }

    this.setData({ saving: true, errorText: '' })
    try {
      const res = await api.createStaff({
        username: username,
        name: name,
        role: this.data.isAdmin ? f.role : 'staff',
        phone: String(f.phone || '').trim(),
        dept: String(f.dept || '').trim(),
        remark: String(f.remark || '').trim(),
        password: pwd
      })
      this.setData({ saving: false })

      const staff = (res && res.staff) || {}
      const initPwd = res && res.initial_password
      const lines = []
      lines.push('姓名：' + (staff.name || name))
      lines.push('登录账号：' + (staff.username || username))
      lines.push('初始密码：' + (initPwd || pwd))
      lines.push('身份：' + roles.roleLabel(staff.role || 'staff'))
      lines.push('')
      if (res && res.need_review) {
        lines.push('已提交给管理员审批，审批通过后对方即可登录。')
      } else {
        lines.push('账号已生效，请把账号密码转告本人，首次登录后建议修改密码。')
      }

      wx.showModal({
        title: res && res.need_review ? '已提交审批' : '账号已创建',
        content: lines.join('\n'),
        showCancel: true,
        cancelText: '返回',
        confirmText: '复制信息',
        success: (m) => {
          if (m.confirm) {
            wx.setClipboardData({ data: lines.join('\n') })
          }
          setTimeout(function () {
            wx.navigateBack({ delta: 1 })
          }, 600)
        }
      })
    } catch (e) {
      this.setData({ saving: false, errorText: util.friendlyError(e) })
    }
  },

  /* ---------------- 审批 ---------------- */

  async doApprove() {
    const d = this.data.detail
    util.loading('处理中')
    try {
      await api.reviewStaff(d.id, true, this.data.newRole, this.data.reviewNote)
      util.hideLoading()
      util.toast('已通过', 'success')
      this.load()
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  doReject() {
    const d = this.data.detail
    wx.showModal({
      title: '驳回「' + d.name + '」的申请',
      editable: true,
      placeholderText: '填写驳回原因（可选）',
      success: (m) => {
        if (!m.confirm) return
        util.loading('处理中')
        api
          .reviewStaff(d.id, false, null, m.content || '')
          .then(() => {
            util.hideLoading()
            util.toast('已驳回', 'success')
            this.load()
          })
          .catch((e) => {
            util.hideLoading()
            util.toast(util.friendlyError(e))
          })
      }
    })
  },

  /* ---------------- 管理操作 ---------------- */

  async saveRole() {
    const d = this.data.detail
    if (this.data.newRole === d.role) {
      util.toast('身份没有变化')
      return
    }
    util.loading('保存中')
    try {
      await api.updateStaff({
        id: d.id,
        name: d.name,
        phone: d.phone,
        dept: d.dept,
        role: this.data.newRole,
        status: d.status
      })
      util.hideLoading()
      util.toast('身份已更新', 'success')
      this.load()
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  async toggleStatus() {
    const d = this.data.detail
    const next = d.status === 'disabled' ? 'active' : 'disabled'
    const confirmFirst = next === 'disabled'
    if (confirmFirst) {
      const ok = await new Promise(function (resolve) {
        wx.showModal({
          title: '停用账号',
          content: '停用后「' + d.name + '」将立即无法登录，历史记录会保留。',
          confirmText: '停用',
          confirmColor: '#ef4444',
          success: (m) => resolve(m.confirm)
        })
      })
      if (!ok) return
    }
    util.loading('处理中')
    try {
      await api.updateStaff({
        id: d.id,
        name: d.name,
        phone: d.phone,
        dept: d.dept,
        role: d.role,
        status: next
      })
      util.hideLoading()
      util.toast(next === 'disabled' ? '已停用' : '已启用', 'success')
      this.load()
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  async doResetPassword() {
    const d = this.data.detail
    const pwd = String(this.data.resetPwd || '').trim()
    if (pwd && pwd.length < 6) {
      util.toast('密码至少 6 位')
      return
    }
    util.loading('重置中')
    try {
      const res = await api.resetStaffPassword(d.id, pwd || null)
      util.hideLoading()
      const finalPwd = (res && res.password) || pwd
      wx.showModal({
        title: '密码已重置',
        content: '账号：' + d.username + '\n新密码：' + finalPwd + '\n\n对方的登录状态已失效，需要用新密码重新登录。',
        confirmText: '复制密码',
        success: (m) => {
          if (m.confirm) wx.setClipboardData({ data: finalPwd })
        }
      })
      this.setData({ resetPwd: '' })
      this.load()
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  doDelete() {
    const d = this.data.detail
    wx.showModal({
      title: '删除账号',
      content: '将删除「' + d.name + '（' + d.username + '）」的登录账号。他做过的出入库记录会保留。此操作不可撤销。',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: (m) => {
        if (!m.confirm) return
        util.loading('删除中')
        api
          .deleteStaff(d.id)
          .then(() => {
            util.hideLoading()
            util.toast('已删除', 'success')
            setTimeout(function () {
              wx.navigateBack({ delta: 1 })
            }, 600)
          })
          .catch((e) => {
            util.hideLoading()
            util.toast(util.friendlyError(e))
          })
      }
    })
  }
})

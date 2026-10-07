/**
 * 登录态与权限
 *
 * 两级身份：
 *   1. 云端会话（微信静默登录）—— 数据接口要求的「已认证」通道，用户无感知；
 *   2. 员工账号（账号 + 密码）—— 真正决定「你是谁、能看到哪个后台」。
 *
 * 页面统一用 requireSession() 拿当前员工，用 can() 判权限。
 */
const { getCloud } = require('./cloud')
const session = require('./session')
const rpc = require('./rpc')
const roles = require('./roles')

let redirecting = false
let cloudSessionReady = false
let lastValidated = 0
const REVALIDATE_MS = 60 * 1000

/* ---------------- 云端会话 ---------------- */

/** 静默建立云端会话；已就绪时直接复用，不重复请求 */
async function ensureCloudSession() {
  if (cloudSessionReady) return true

  try {
    const res = await getCloud().auth.getSession()
    if (res && res.data) {
      cloudSessionReady = true
      return res.data
    }
  } catch (e) {
    // 未登录属正常情况，继续走微信登录
  }

  const code = await new Promise(function (resolve, reject) {
    wx.login({
      success: function (r) {
        if (r && r.code) resolve(r.code)
        else reject(new Error('云端身份初始化失败，请重试'))
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '云端身份初始化失败，请重试'))
      }
    })
  })

  const appid = wx.getAccountInfoSync().miniProgram.appId
  const res = await getCloud().auth.signInWithWechat(code, appid)
  if (res && res.error) throw res.error
  cloudSessionReady = true
  return res && res.data
}

/* ---------------- 角色缓存 ---------------- */

function applyRole(staff) {
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.staff = staff || null
      app.globalData.role = (staff && staff.role) || ''
    }
  } catch (e) {
    // getApp 在极早期可能拿不到，忽略
  }
}

function currentProfile() {
  return session.getProfile()
}

function currentRole() {
  const p = session.getProfile()
  return (p && p.role) || ''
}

function isSignedIn() {
  return !!session.getToken() && !!currentRole()
}

function can(cap) {
  return roles.can(currentRole(), cap)
}

function caps() {
  return roles.caps(currentRole())
}

/* ---------------- 登录 / 退出 ---------------- */

/**
 * 账号密码登录。
 * 失败时抛出带业务错误码的异常，由 util.friendlyError 翻译成中文。
 */
async function login(username, password) {
  await ensureCloudSession()
  const data = await rpc.callPublic('staff_login', {
    p_username: String(username || '').trim(),
    p_password: String(password || '')
  })
  if (!data || !data.token) throw new Error('LOGIN_FAILED')
  session.save(data.token, data.staff)
  applyRole(data.staff)
  lastValidated = Date.now()
  return data.staff
}

function isAuthError(err) {
  const msg = (err && (err.message || err.errMsg)) || ''
  return /NOT_SIGNED_IN|SESSION_EXPIRED|ACCOUNT_DISABLED|unauthenticated|invalid_grant|401/i.test(msg)
}

/**
 * 用本地令牌恢复登录态。
 * 网络异常时退回本地缓存，避免一断网就被踢回登录页。
 */
async function restore() {
  const token = session.getToken()
  if (!token) return null

  const cached = session.getProfile()
  if (cached) applyRole(cached)

  // 刚校验过就不重复请求，避免每次切页都打一次接口
  if (cached && Date.now() - lastValidated < REVALIDATE_MS) return cached

  try {
    await ensureCloudSession()
    const me = await rpc.call('staff_me', { p_token: token })
    if (!me || !me.role) {
      session.clear()
      applyRole(null)
      return null
    }
    lastValidated = Date.now()
    session.setProfile(me)
    applyRole(me)
    return me
  } catch (e) {
    if (isAuthError(e)) {
      session.clear()
      applyRole(null)
      return null
    }
    // 网络问题：先用缓存顶上
    return cached
  }
}

/** 退出登录（清服务端会话 + 本地缓存） */
async function signOut() {
  const token = session.getToken()
  if (token) {
    try {
      await rpc.callPublic('staff_logout', { p_token: token })
    } catch (e) {
      // 服务端清理失败不影响本地退出
    }
  }
  session.clear()
  applyRole(null)
  lastValidated = 0
}

/** 登录后 / 改完资料后强制下次刷新 */
function invalidate() {
  lastValidated = 0
}

/** 页面入口统一调用：没登录就跳登录页并返回 null */
async function requireSession() {
  const me = await restore()
  if (me) return me

  if (!redirecting) {
    redirecting = true
    wx.reLaunch({
      url: '/pages/login/login',
      complete: function () {
        redirecting = false
      }
    })
  }
  return null
}

/* ---------------- 账号自助 ---------------- */

async function changePassword(oldPassword, newPassword) {
  const data = await rpc.call('staff_change_password', {
    p_old: oldPassword,
    p_new: newPassword
  })
  const me = session.getProfile()
  if (me) {
    me.must_change_password = false
    session.setProfile(me)
    applyRole(me)
  }
  return data
}

async function updateProfile(name, phone, dept) {
  const data = await rpc.call('staff_update_profile', {
    p_name: name,
    p_phone: phone || null,
    p_dept: dept || null
  })
  if (data) {
    session.setProfile(data)
    applyRole(data)
    lastValidated = Date.now()
  }
  return data
}

/** 登录后应该进入的首页（三种角色各不相同） */
function homeUrl(role) {
  return '/pages/index/index'
}

/** 兼容旧调用：操作人姓名就是当前账号姓名 */
function getOperatorName() {
  const p = session.getProfile()
  return (p && p.name) || ''
}

module.exports = {
  ensureCloudSession: ensureCloudSession,
  login: login,
  restore: restore,
  requireSession: requireSession,
  signOut: signOut,
  invalidate: invalidate,
  isSignedIn: isSignedIn,
  currentRole: currentRole,
  currentProfile: currentProfile,
  applyRole: applyRole,
  can: can,
  caps: caps,
  changePassword: changePassword,
  updateProfile: updateProfile,
  homeUrl: homeUrl,
  getOperatorName: getOperatorName
}

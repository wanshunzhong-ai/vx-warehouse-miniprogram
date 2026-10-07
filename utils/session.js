/**
 * 登录态存储（**仅进程内存，不落盘**）
 *
 * 既定策略：**每次打开小程序都要重新登录**。
 * 因此这里的令牌 / 资料只保存在内存变量里，不写 wx.storage：
 * 小程序一旦冷启动（首次打开、被微信回收后重开、开发者工具「编译」），
 * 内存即清空 → 由 auth.requireSession() 统一跳回登录页。
 *
 * 为什么不做「切后台就登出」：小程序切到后台时进程仍活着，内存还在，
 * 用户切回来仍保持登录。否则扫码、选文件（wx.chooseMessageFile）等
 * 系统弹窗会触发 onHide/onShow，导致操作到一半被踢下线。
 *
 * 单独抽出来是为了避免 auth.js 和 api.js 互相 require 造成循环依赖。
 */

const TOKEN_KEY = 'warehouse_staff_token'
const PROFILE_KEY = 'warehouse_staff_profile'

let _token = ''
let _profile = null

/**
 * 清理历史版本残留在 Storage 里的登录态。
 * 旧版本会把令牌落盘，升级后必须清掉，否则「每次打开都要登录」不生效。
 */
function purgeLegacy() {
  try {
    wx.removeStorageSync(TOKEN_KEY)
    wx.removeStorageSync(PROFILE_KEY)
  } catch (e) {
    // 忽略
  }
}

function getToken() {
  return _token
}

function getProfile() {
  return _profile
}

function save(token, profile) {
  purgeLegacy()
  _token = token || ''
  _profile = profile || null
}

function setProfile(profile) {
  _profile = profile || null
}

function clear() {
  purgeLegacy()
  _token = ''
  _profile = null
}

module.exports = {
  getToken: getToken,
  getProfile: getProfile,
  save: save,
  setProfile: setProfile,
  clear: clear,
  purgeLegacy: purgeLegacy
}

/**
 * 本地登录态存储（纯读写，不碰网络）
 *
 * 单独抽出来是为了避免 auth.js 和 api.js 互相 require 造成循环依赖。
 */

const TOKEN_KEY = 'warehouse_staff_token'
const PROFILE_KEY = 'warehouse_staff_profile'

let _token = ''
let _profile = null
let _loaded = false

function load() {
  if (_loaded) return
  _loaded = true
  try {
    _token = wx.getStorageSync(TOKEN_KEY) || ''
    const p = wx.getStorageSync(PROFILE_KEY)
    _profile = p && typeof p === 'object' ? p : null
  } catch (e) {
    _token = ''
    _profile = null
  }
}

function getToken() {
  load()
  return _token
}

function getProfile() {
  load()
  return _profile
}

function save(token, profile) {
  load()
  _token = token || ''
  _profile = profile || null
  try {
    if (_token) wx.setStorageSync(TOKEN_KEY, _token)
    else wx.removeStorageSync(TOKEN_KEY)
    if (_profile) wx.setStorageSync(PROFILE_KEY, _profile)
    else wx.removeStorageSync(PROFILE_KEY)
  } catch (e) {
    // 存储失败不影响本次会话
  }
}

function setProfile(profile) {
  load()
  _profile = profile || null
  try {
    if (_profile) wx.setStorageSync(PROFILE_KEY, _profile)
    else wx.removeStorageSync(PROFILE_KEY)
  } catch (e) {
    // 忽略
  }
}

function clear() {
  load()
  _token = ''
  _profile = null
  try {
    wx.removeStorageSync(TOKEN_KEY)
    wx.removeStorageSync(PROFILE_KEY)
  } catch (e) {
    // 忽略
  }
}

module.exports = {
  getToken: getToken,
  getProfile: getProfile,
  save: save,
  setProfile: setProfile,
  clear: clear
}

/**
 * 云服务客户端（全应用唯一实例）
 *
 * endpoint / publishableKey 取自云服务开通时下发的 publicConfig。
 * 小程序没有 location.origin，两者都必须显式传入。
 *
 * SDK 加载顺序（很重要）：
 *   1. 先用相对路径直接指向构建产物
 *      miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js，
 *      这样完全不依赖开发者工具的 npm 解析规则 —— 哪怕「构建 npm」状态异常也能跑；
 *   2. 上面的文件缺失时才回退到按包名 require（需先在工具里执行「工具 → 构建 npm」）。
 *
 * 注意：require 的路径必须写成静态字符串，小程序才能做依赖分析。
 *
 * 另外这里是「懒加载」：require 本模块本身不加载 SDK、不碰 wx，
 * 只有真正要读写云端时才建客户端，且失败只在那一次调用上报错，
 * 不会让整个小程序在启动阶段直接崩掉。
 */
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const publicConfig = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_V5TDHdOmlEdRT5Esp5xvPo_FSVQc58M4CPCzP3CGfpGub6WFR4VcBZ4',
}

function loadSDK() {
  try {
    return require('../miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js')
  } catch (e) {
    try {
      return require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
    } catch (e2) {
      throw new Error(
        '找不到云服务 SDK：请确认项目里存在 ' +
          'miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js，' +
          '或在开发者工具执行「工具 → 构建 npm」。原始错误：' +
          ((e2 && e2.message) || e2)
      )
    }
  }
}

let _cloud = null

/** 懒初始化：首次真正需要云端能力时才建立客户端；同一个实例被所有模块复用 */
function getCloud() {
  if (_cloud) return _cloud

  if (typeof wx === 'undefined' || !wx) {
    throw new Error('当前不在小程序环境里（找不到 wx 对象），云服务无法初始化。')
  }

  const sdk = loadSDK()

  try {
    _cloud = sdk.createMiniProgramWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      publishableKey: publicConfig.publishableKey,
      // 只包这一层，不改全局 wx.request，也不碰 SDK 自己的请求与鉴权逻辑
      wx: createDiagnosticWx(wx),
    })
  } catch (err) {
    // 初始化失败不缓存，允许下次重试
    _cloud = null
    throw new Error('云服务初始化失败：' + ((err && (err.message || err.errMsg)) || err))
  }

  return _cloud
}

/** 数据库客户端快捷方式 */
function getDB() {
  return getCloud().database
}

module.exports = {
  publicConfig: publicConfig,
  getCloud: getCloud,
  getDB: getDB
}

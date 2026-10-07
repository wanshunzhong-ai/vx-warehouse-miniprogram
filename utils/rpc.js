/**
 * 服务端接口调用层
 *
 * 所有业务读写都走云数据库的 rpc；带权限的操作会把当前登录令牌一起传上去，
 * 由数据库函数校验身份和角色后再落库。
 */
const { getDB } = require('./cloud')
const session = require('./session')

function firstValue(row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const keys = Object.keys(row)
    if (keys.length === 1) return row[keys[0]]
  }
  return row
}

/**
 * 数据库函数返回单值（json / text）时，结果会被包成 [{ 函数名: 值 }]；
 * 返回集合（SETOF）时则是多行的数组。这里统一摊平。
 */
function unwrap(res) {
  if (res && res.error) throw res.error
  const data = res ? res.data : null
  if (data == null) return null
  if (Array.isArray(data)) {
    if (data.length === 0) return null
    if (data.length === 1) return firstValue(data[0])
    return data
  }
  return firstValue(data)
}

/** 需要登录态才能调用的函数：自动带上令牌 */
function call(name, args) {
  const params = Object.assign({}, args || {})
  if (!Object.prototype.hasOwnProperty.call(params, 'p_token')) {
    params.p_token = session.getToken()
  }
  return getDB().rpc(name, params).then(unwrap)
}

/** 不依赖登录态（登录本身） */
function callPublic(name, args) {
  return getDB().rpc(name, args || {}).then(unwrap)
}

module.exports = {
  unwrap: unwrap,
  call: call,
  callPublic: callPublic
}

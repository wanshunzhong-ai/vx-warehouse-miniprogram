/** 最近扫描的物品（本地记录，方便重复出入库） */
const KEY = 'warehouse_recent_items'
const MAX = 8

function list() {
  const arr = wx.getStorageSync(KEY)
  return Array.isArray(arr) ? arr : []
}

function push(item) {
  if (!item || !item.code) return
  const arr = list().filter(function (x) {
    return x.code !== item.code
  })
  arr.unshift({ code: item.code, name: item.name || '', at: Date.now() })
  wx.setStorageSync(KEY, arr.slice(0, MAX))
}

function clear() {
  wx.removeStorageSync(KEY)
}

module.exports = { list: list, push: push, clear: clear }

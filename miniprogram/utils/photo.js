/**
 * 物品位置照片：拍摄 / 选图 → 压缩 → 上传云端存储 → 换取短期签名链接
 *
 * 为什么图片不直接存数据库：
 *   图片是二进制大对象，塞进 items 表会让每次列表查询都拖着几十 KB 的无用数据，
 *   所以 items.photo 里只记「对象路径」，图片本体放云端存储，要用的时候现换一个短期链接。
 *
 * 路径约定：shared/<上传者 uid>/items/<物品id>-<时间戳>.jpg
 *   · 放 shared 下：仓库是团队共用的，任何已登录的人都要能看到别人拍的位置照片；
 *     （users/<uid>/ 只有本人可读，拿来做团队共享会互相看不见）
 *   · 文件名带物品 id 与时间戳：换照片时不会命中旧缓存，也不会互相覆盖。
 *
 * 签名链接有效期最长 1 小时，因此它只放在内存缓存里，快到期自动换新的；
 * 数据库里存的永远是路径，不是链接。
 */
const { getCloud } = require('./cloud')

const SIGN_TTL = 3600        // 签名链接有效期（秒）。SDK 上限就是 3600
const REFRESH_AHEAD = 300    // 距过期不足这个秒数就重新签一次
const MAX_WIDTH = 1000       // 压缩后最长边，够看清货架位置了
const QUALITY = 72           // 压缩质量
const MAX_BYTES = 4 * 1024 * 1024  // 兜底：压缩后仍超过这个体积就拒绝上传

/** 内存缓存：path -> { url, expireAt }，绝不写 storage（链接是短期的，落盘没意义） */
const urlCache = {}

function fail(msg) {
  const e = new Error(msg)
  return e
}

/** 归一化 SDK 的 { data, error } 结果：出错就抛，成功就返回 data */
function unwrap(res, what) {
  if (!res) throw fail(what + '失败，请重试')
  if (res.error) throw fail((res.error && (res.error.message || res.error)) || what + '失败')
  return res.data
}

function fileSystem() {
  return wx.getFileSystemManager()
}

/** 当前云端会话：小程序启动时 auth.ensureCloudSession() 已静默建立，这里只读 */
async function sessionUid() {
  const res = await getCloud().auth.getSession()
  const s = res && res.data
  const u = s && s.user
  const uid = (u && (u.id || u.uid || u.userId)) || ''
  if (!uid) throw fail('云端身份尚未就绪，请重新登录后再试')
  return String(uid)
}

/** 选图（相册或拍照）。用户主动取消不算错误，抛 CANCELED 让调用方安静收场 */
function choosePhoto() {
  return new Promise(function (resolve, reject) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      camera: 'back',
      success: function (res) {
        const f = res && res.tempFiles && res.tempFiles[0]
        if (!f || !f.tempFilePath) {
          reject(fail('没有取到图片，请重试'))
          return
        }
        resolve(f.tempFilePath)
      },
      fail: function (err) {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') !== -1) {
          reject(fail('CANCELED'))
          return
        }
        if (msg.indexOf('auth deny') !== -1 || msg.indexOf('authorize') !== -1 || msg.indexOf('authDeny') !== -1) {
          reject(fail('PHOTO_PERMISSION_DENIED'))
          return
        }
        reject(fail('打开相机/相册失败，请重试'))
      }
    })
  })
}

/**
 * 压缩：手机直出图动辄 3~5MB，直接上传又慢又占空间。
 * 压不动就用原图 —— 宁可能传上去，也不要因为压缩失败卡住流程。
 */
function compress(src) {
  return new Promise(function (resolve) {
    wx.compressImage({
      src: src,
      quality: QUALITY,
      compressedWidth: MAX_WIDTH,
      success: function (res) {
        resolve((res && res.tempFilePath) || src)
      },
      fail: function () {
        resolve(src)
      }
    })
  })
}

/** 读成 ArrayBuffer —— 小程序里没有 File/Blob，上传接口要的就是这个 */
function readBuffer(filePath) {
  return new Promise(function (resolve, reject) {
    fileSystem().readFile({
      filePath: filePath,
      success: function (res) {
        resolve(res.data)
      },
      fail: function (err) {
        reject(fail('读取图片失败：' + ((err && err.errMsg) || '未知原因')))
      }
    })
  })
}

/**
 * 上传一张位置照片，返回可直接存进 items.photo 的对象路径。
 * itemId 用来给文件命名，便于排查「这张图是谁的」。
 */
async function upload(itemId, tempFilePath) {
  const cloud = getCloud()
  const uid = await sessionUid()

  const small = await compress(tempFilePath)
  const body = await readBuffer(small)
  const size = (body && body.byteLength) || 0
  if (size > MAX_BYTES) throw fail('PHOTO_TOO_LARGE')

  const path = cloud.storage.sharedPath(
    uid,
    'items/' + itemId + '-' + Date.now() + '.jpg'
  )
  const res = await cloud.storage.upload(path, body, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false
  })
  unwrap(res, '上传')
  return path
}

/** 换照片后清掉旧对象：只有上传者本人有权删除，删不掉也不影响功能 */
async function remove(path) {
  if (!path) return
  try {
    const res = await getCloud().storage.remove([path])
    unwrap(res, '删除')
  } catch (e) {
    // 别人拍的旧图删不掉是正常情况，忽略即可
  }
}

/** 用对象路径换一个可访问的签名链接（带内存缓存，临期自动续） */
async function signUrl(path) {
  if (!path) return ''
  const now = Math.floor(Date.now() / 1000)
  const hit = urlCache[path]
  if (hit && hit.expireAt - REFRESH_AHEAD > now) return hit.url

  const res = await getCloud().storage.createSignedUrl(path, SIGN_TTL)
  const data = unwrap(res, '获取图片地址')
  const url = (data && data.signedUrl) || ''
  if (!url) throw fail('获取图片地址失败')
  urlCache[path] = { url: url, expireAt: now + SIGN_TTL }
  return url
}

/** 批量换链接（列表页要一次显示多张时用） */
async function signUrls(paths) {
  const list = (paths || []).filter(function (p) { return !!p })
  const out = {}
  if (!list.length) return out

  const now = Math.floor(Date.now() / 1000)
  const missing = []
  list.forEach(function (p) {
    const hit = urlCache[p]
    if (hit && hit.expireAt - REFRESH_AHEAD > now) out[p] = hit.url
    else missing.push(p)
  })
  if (!missing.length) return out

  const res = await getCloud().storage.createSignedUrls(missing, SIGN_TTL)
  const rows = unwrap(res, '获取图片地址') || []
  rows.forEach(function (row, i) {
    const url = (row && (row.signedUrl || row.signedURL)) || ''
    const p = (row && (row.path || row.fullPath)) || missing[i]
    if (url && p) {
      urlCache[p] = { url: url, expireAt: now + SIGN_TTL }
      out[p] = url
    }
  })
  return out
}

module.exports = {
  choosePhoto: choosePhoto,
  upload: upload,
  remove: remove,
  signUrl: signUrl,
  signUrls: signUrls
}

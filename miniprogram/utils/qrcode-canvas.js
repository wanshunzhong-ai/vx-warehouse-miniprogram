/** 把二维码模块矩阵绘制到 Canvas 2D 节点上 */
const WBQR = require('./qr')

/**
 * @param {Object} canvas  canvas 2d 节点
 * @param {Number} size    绘制边长（px）
 * @param {String} text    二维码内容
 * @param {Object} options { dark, light, quiet }
 */
function draw(canvas, size, text, options) {
  const opt = options || {}
  const quiet = opt.quiet == null ? 2 : opt.quiet
  const qr = WBQR.encode(text)
  const total = qr.size + quiet * 2
  const cell = size / total

  const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2
  canvas.width = Math.floor(size * dpr)
  canvas.height = Math.floor(size * dpr)
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  ctx.fillStyle = opt.light || '#ffffff'
  ctx.fillRect(0, 0, size, size)

  ctx.fillStyle = opt.dark || '#10131a'
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue
      const x = (c + quiet) * cell
      const y = (r + quiet) * cell
      ctx.fillRect(
        Math.floor(x),
        Math.floor(y),
        Math.ceil(cell),
        Math.ceil(cell)
      )
    }
  }
  return qr
}

/** 导出为临时图片路径，可用于预览或保存到相册 */
function toTempFilePath(canvas, size, component) {
  return new Promise(function (resolve, reject) {
    const opts = {
      canvas: canvas,
      x: 0,
      y: 0,
      width: size,
      height: size,
      destWidth: size * 2,
      destHeight: size * 2,
      fileType: 'png',
      success: function (res) {
        resolve(res.tempFilePath)
      },
      fail: reject
    }
    if (component) {
      wx.canvasToTempFilePath(opts, component)
    } else {
      wx.canvasToTempFilePath(opts)
    }
  })
}

module.exports = { draw: draw, toTempFilePath: toTempFilePath }

/*!
 * qr.js — 轻量二维码编码器
 * 字节模式，版本 1–6，纠错等级 M，无任何外部依赖。
 * 同时支持 CommonJS（小程序 require）与浏览器 <script>（全局 WBQR）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WBQR = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_VERSION = 6;
  var MAX_BYTES = 106;

  /* ---------------- GF(256) ---------------- */

  var EXP = new Array(512);
  var LOG = new Array(256);

  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGenerator(ecLen) {
    var gen = [1];
    for (var i = 0; i < ecLen; i++) {
      var a = EXP[i];
      var next = [];
      for (var k = 0; k <= gen.length; k++) next[k] = 0;
      for (var m = 0; m < gen.length; m++) {
        next[m] ^= gen[m];
        next[m + 1] ^= gfMul(gen[m], a);
      }
      gen = next;
    }
    return gen;
  }

  var GEN_CACHE = {};

  function rsRemainder(data, ecLen) {
    var gen = GEN_CACHE[ecLen] || (GEN_CACHE[ecLen] = rsGenerator(ecLen));
    var res = [];
    for (var i = 0; i < ecLen; i++) res[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return res;
  }

  /* ---------------- 版本表（纠错等级 M） ---------------- */

  var BLOCKS = {
    1: [[26, 16]],
    2: [[44, 28]],
    3: [[70, 44]],
    4: [[50, 32], [50, 32]],
    5: [[67, 43], [67, 43]],
    6: [[43, 27], [43, 27], [43, 27], [43, 27]]
  };

  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  function sizeOf(version) {
    return version * 4 + 17;
  }

  function dataCodewords(version) {
    var blocks = BLOCKS[version];
    var t = 0;
    for (var i = 0; i < blocks.length; i++) t += blocks[i][1];
    return t;
  }

  function totalCodewords(version) {
    var blocks = BLOCKS[version];
    var t = 0;
    for (var i = 0; i < blocks.length; i++) t += blocks[i][0];
    return t;
  }

  /* ---------------- UTF-8 ---------------- */

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  /* ---------------- 生成码字（数据 + 纠错 + 交织） ---------------- */

  function buildCodewords(bytes, version) {
    var dataCount = dataCodewords(version);
    var totalCount = totalCodewords(version);
    var bits = [];

    function put(value, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    }

    put(4, 4);            // 字节模式
    put(bytes.length, 8); // 版本 1–9 长度为 8 位
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);

    var capBits = dataCount * 8;
    if (bits.length > capBits) throw new Error('内容过长');
    var term = Math.min(4, capBits - bits.length);
    for (var t = 0; t < term; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var dataBytes = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      dataBytes.push(byte);
    }
    var PAD = [0xec, 0x11];
    var pi = 0;
    while (dataBytes.length < dataCount) {
      dataBytes.push(PAD[pi % 2]);
      pi++;
    }

    var blocks = BLOCKS[version];
    var dc = [];
    var ec = [];
    var maxDc = 0;
    var maxEc = 0;
    var offset = 0;

    for (var r = 0; r < blocks.length; r++) {
      var dCount = blocks[r][1];
      var eCount = blocks[r][0] - dCount;
      maxDc = Math.max(maxDc, dCount);
      maxEc = Math.max(maxEc, eCount);
      dc[r] = dataBytes.slice(offset, offset + dCount);
      offset += dCount;
      ec[r] = rsRemainder(dc[r], eCount);
    }

    var out = [];
    for (var a = 0; a < maxDc; a++) {
      for (var p = 0; p < blocks.length; p++) if (a < dc[p].length) out.push(dc[p][a]);
    }
    for (var q = 0; q < maxEc; q++) {
      for (var s = 0; s < blocks.length; s++) if (q < ec[s].length) out.push(ec[s][q]);
    }
    if (out.length !== totalCount) throw new Error('码字数不匹配');
    return out;
  }

  /* ---------------- 掩码 / 格式信息 ---------------- */

  var MASK_FN = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return ((i * j) % 2) + ((i * j) % 3) === 0; },
    function (i, j) { return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0; },
    function (i, j) { return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0; }
  ];

  var G15 = 0x537;
  var G15_MASK = 0x5412;

  function bchDigit(data) {
    var d = 0;
    while (data !== 0) {
      d++;
      data >>>= 1;
    }
    return d;
  }

  function bchTypeInfo(data) {
    var d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
    return ((data << 10) | d) ^ G15_MASK;
  }

  function placeFormat(m, size, mask, test) {
    var bits = bchTypeInfo(mask); // 纠错等级 M 的指示位为 0
    var i, mod;
    for (i = 0; i < 15; i++) {
      mod = !test && ((bits >> i) & 1) === 1;
      if (i < 6) m[i][8] = mod;
      else if (i < 8) m[i + 1][8] = mod;
      else m[size - 15 + i][8] = mod;
    }
    for (i = 0; i < 15; i++) {
      mod = !test && ((bits >> i) & 1) === 1;
      if (i < 8) m[8][size - i - 1] = mod;
      else if (i < 9) m[8][15 - i] = mod;
      else m[8][15 - i - 1] = mod;
    }
    m[size - 8][8] = !test;
  }

  /* ---------------- 矩阵构建 ---------------- */

  function makeMatrix(version, codewords, mask) {
    var size = sizeOf(version);
    var m = [];
    var r, c, i, j;

    for (r = 0; r < size; r++) {
      m[r] = [];
      for (c = 0; c < size; c++) m[r][c] = null;
    }

    function probe(row, col) {
      for (var dr = -1; dr <= 7; dr++) {
        if (row + dr < 0 || row + dr >= size) continue;
        for (var dcx = -1; dcx <= 7; dcx++) {
          if (col + dcx < 0 || col + dcx >= size) continue;
          var dark =
            (dr >= 0 && dr <= 6 && (dcx === 0 || dcx === 6)) ||
            (dcx >= 0 && dcx <= 6 && (dr === 0 || dr === 6)) ||
            (dr >= 2 && dr <= 4 && dcx >= 2 && dcx <= 4);
          m[row + dr][col + dcx] = !!dark;
        }
      }
    }

    probe(0, 0);
    probe(size - 7, 0);
    probe(0, size - 7);

    var pos = ALIGN[version];
    for (i = 0; i < pos.length; i++) {
      for (j = 0; j < pos.length; j++) {
        var ar = pos[i];
        var ac = pos[j];
        if (m[ar][ac] !== null) continue;
        for (var rr = -2; rr <= 2; rr++) {
          for (var cc = -2; cc <= 2; cc++) {
            m[ar + rr][ac + cc] = Math.abs(rr) === 2 || Math.abs(cc) === 2 || (rr === 0 && cc === 0);
          }
        }
      }
    }

    for (r = 8; r < size - 8; r++) if (m[r][6] === null) m[r][6] = r % 2 === 0;
    for (c = 8; c < size - 8; c++) if (m[6][c] === null) m[6][c] = c % 2 === 0;

    placeFormat(m, size, mask, true);

    var inc = -1;
    var row = size - 1;
    var bitIndex = 7;
    var byteIndex = 0;
    var maskFn = MASK_FN[mask];

    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (var side = 0; side < 2; side++) {
          var cx = col - side;
          if (m[row][cx] === null) {
            var dark = false;
            if (byteIndex < codewords.length) {
              dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFn(row, cx)) dark = !dark;
            m[row][cx] = dark;
            bitIndex--;
            if (bitIndex === -1) {
              byteIndex++;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || row >= size) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }

    placeFormat(m, size, mask, false);
    return m;
  }

  /* ---------------- 掩码评分 ---------------- */

  function penalty(m, size) {
    var p = 0;
    var dark = 0;
    var r, c, k;

    for (r = 0; r < size; r++) {
      var run = 1;
      for (c = 0; c < size; c++) if (m[r][c]) dark++;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) {
          run++;
        } else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) p += 3 + (run - 5);
    }

    for (c = 0; c < size; c++) {
      var vrun = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) {
          vrun++;
        } else {
          if (vrun >= 5) p += 3 + (vrun - 5);
          vrun = 1;
        }
      }
      if (vrun >= 5) p += 3 + (vrun - 5);
    }

    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) p += 3;
      }
    }

    var pat = [true, false, true, true, true, false, true];
    function scan(get) {
      for (var i = 0; i + 7 <= size; i++) {
        var ok = true;
        for (var q = 0; q < 7; q++) {
          if (get(i + q) !== pat[q]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        var before = true;
        for (k = 1; k <= 4; k++) {
          if (i - k < 0 || get(i - k)) {
            before = false;
            break;
          }
        }
        var after = true;
        for (k = 0; k < 4; k++) {
          if (i + 7 + k >= size || get(i + 7 + k)) {
            after = false;
            break;
          }
        }
        if (before || after) p += 40;
      }
    }
    for (r = 0; r < size; r++) {
      (function (rowIdx) {
        scan(function (colIdx) {
          return m[rowIdx][colIdx];
        });
      })(r);
    }
    for (c = 0; c < size; c++) {
      (function (colIdx) {
        scan(function (rowIdx) {
          return m[rowIdx][colIdx];
        });
      })(c);
    }

    var ratio = Math.abs((100 * dark) / (size * size) - 50) / 5;
    p += Math.floor(ratio) * 10;
    return p;
  }

  /* ---------------- 对外接口 ---------------- */

  function encode(text) {
    var bytes = utf8Bytes(String(text == null ? '' : text));
    if (!bytes.length) throw new Error('内容不能为空');
    if (bytes.length > MAX_BYTES) throw new Error('内容过长，最多 ' + MAX_BYTES + ' 字节');

    var version = 0;
    for (var v = 1; v <= MAX_VERSION; v++) {
      if (bytes.length <= dataCodewords(v) - 2) {
        version = v;
        break;
      }
    }
    if (!version) throw new Error('内容过长');

    var codewords = buildCodewords(bytes, version);
    var size = sizeOf(version);
    var best = null;
    var bestScore = Infinity;

    for (var mask = 0; mask < 8; mask++) {
      var m = makeMatrix(version, codewords, mask);
      var score = penalty(m, size);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }

    return { version: version, size: size, modules: best };
  }

  /* 生成 SVG 字符串，方便网页端直接插入 */
  function toSvg(text, options) {
    var opt = options || {};
    var quiet = opt.quiet == null ? 2 : opt.quiet;
    var dark = opt.dark || '#000000';
    var light = opt.light || '#ffffff';
    var qr = encode(text);
    var dim = qr.size + quiet * 2;
    var path = [];
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) path.push('M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z');
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" ' +
      'shape-rendering="crispEdges" width="100%" height="100%">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + path.join('') + '" fill="' + dark + '"/>' +
      '</svg>'
    );
  }

  return {
    encode: encode,
    toSvg: toSvg,
    MAX_BYTES: MAX_BYTES
  };
});

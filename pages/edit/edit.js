const app = getApp()
const api = require('../../utils/api')
const util = require('../../utils/util')
const page = require('../../utils/page')

const UNITS = ['个', '件', '箱', '包', '套', '台', '米', '公斤']

Page({
  data: {
    isEdit: false,
    /** 扫码建档模式：从扫码页进来，填完名称直接建档 + 入库（员工也能用） */
    quickIn: false,
    form: {
      code: '',
      name: '',
      spec: '',
      category: '',
      unit: '个',
      location: '',
      qty: '',
      min_qty: '',
      note: ''
    },
    origin: {},
    units: UNITS,
    categories: [],
    saving: false,
    errorText: ''
  },

  onLoad(options) {
    const opts = options || {}
    const quickIn = opts.quickin === '1' && !opts.id

    // 扫码建档走 item.quickcreate（员工也有），普通建档 / 改档仍要 item.create
    if (!page.guard(quickIn ? 'item.quickcreate' : 'item.create')) return

    if (opts.id) {
      this._id = Number(opts.id)
      this.setData({ isEdit: true })
      wx.setNavigationBarTitle({ title: '编辑物品' })
      this.load()
    } else if (quickIn) {
      this.setData({ quickIn: true, 'form.code': decodeURIComponent(opts.code || '') })
      wx.setNavigationBarTitle({ title: '扫码建档' })
    } else {
      wx.setNavigationBarTitle({ title: '新建物品' })
      if (opts.code) {
        this.setData({ 'form.code': decodeURIComponent(opts.code) })
      } else {
        this.genCode()
      }
    }
    this.loadCategories()
  },

  async load() {
    const session = await app.ensureLogin()
    if (!session) return
    try {
      const item = await api.getItemById(this._id)
      if (!item) {
        util.toast('物品不存在或已被删除')
        setTimeout(function () {
          wx.navigateBack({ delta: 1 })
        }, 800)
        return
      }
      this.setData({
        origin: item,
        form: {
          code: item.code,
          name: item.name || '',
          spec: item.spec || '',
          category: item.category || '',
          unit: item.unit || '个',
          location: item.location || '',
          qty: String(item.qty == null ? 0 : item.qty),
          min_qty: String(item.min_qty == null ? 0 : item.min_qty),
          note: item.note || ''
        }
      })
    } catch (e) {
      util.toast(util.friendlyError(e))
    }
  },

  async loadCategories() {
    try {
      const cats = await api.listCategories()
      this.setData({ categories: cats || [] })
    } catch (e) {
      // 分类只用于快捷填充，失败不打扰用户
    }
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch['form.' + key] = e.detail.value
    this.setData(patch)
  },

  pickCategory(e) {
    const cat = e.currentTarget.dataset.cat || ''
    this.setData({ 'form.category': this.data.form.category === cat ? '' : cat })
  },

  pickUnit(e) {
    this.setData({ 'form.unit': e.currentTarget.dataset.unit })
  },

  async genCode() {
    try {
      util.loading('生成编号')
      const code = await api.suggestCode()
      util.hideLoading()
      if (code) this.setData({ 'form.code': String(code).trim() })
      else util.toast('生成失败，请手动填写编号')
    } catch (e) {
      util.hideLoading()
      util.toast(util.friendlyError(e))
    }
  },

  async onSave() {
    if (this.data.saving) return

    const f = this.data.form
    const code = String(f.code || '').trim()
    const name = String(f.name || '').trim()
    // 逐件码带 -1 / -2 后缀，比普通编号长一些
    const limit = this.data.quickIn ? 106 : 40

    if (code.length > limit) {
      this.setData({ errorText: '物品编号请控制在 ' + limit + ' 个字符以内' })
      return
    }
    if (!name) {
      this.setData({ errorText: '请填写物品名称' })
      return
    }

    this.setData({ saving: true, errorText: '' })

    // 扫码建档：档案与入库流水一次落库（服务端原子完成），不必再来一遍出入库
    if (this.data.quickIn) {
      try {
        await api.scanCreateIn({
          code: code,
          name: name,
          spec: String(f.spec || '').trim() || null,
          category: String(f.category || '').trim() || null,
          unit: String(f.unit || '').trim() || '个',
          location: String(f.location || '').trim() || null,
          min_qty: 0,
          qty: 1,
          note: String(f.note || '').trim() || null
        })
        util.toast('已建档并入库', 'success')
        this.setData({ saving: false })
        setTimeout(function () {
          wx.navigateBack({ delta: 1 })
        }, 700)
      } catch (e) {
        this.setData({ saving: false, errorText: util.friendlyError(e) })
      }
      return
    }

    const minQty = parseInt(f.min_qty, 10)
    const payload = {
      id: this.data.isEdit ? this._id : null,
      code: code || null,
      name: name,
      spec: String(f.spec || '').trim() || null,
      category: String(f.category || '').trim() || null,
      unit: String(f.unit || '').trim() || '个',
      location: String(f.location || '').trim() || null,
      min_qty: isNaN(minQty) || minQty < 0 ? 0 : minQty,
      note: String(f.note || '').trim() || null
    }

    this.setData({ saving: true, errorText: '' })

    try {
      // 建档 / 改档都在服务端校验角色；库存不在这里改
      const saved = await api.saveItem(payload)
      if (!saved) throw new Error('创建失败，请重试')

      if (!this.data.isEdit) {
        const initQty = parseInt(f.qty, 10)
        if (!isNaN(initQty) && initQty > 0) {
          // 初始库存照样写一条流水，账面才连得上
          await api.changeStock(saved.code, 'in', initQty, '建档初始库存')
        }
        util.toast('已创建', 'success')
      } else {
        util.toast('已保存', 'success')
      }
      setTimeout(function () {
        wx.navigateBack({ delta: 1 })
      }, 700)
    } catch (e) {
      this.setData({ saving: false, errorText: util.friendlyError(e) })
    }
  }
})

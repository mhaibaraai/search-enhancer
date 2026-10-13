// ==UserScript==
// @name         Search Enhancer - 搜索引擎增强（无缝翻页/去广告/重定向/屏蔽）
// @namespace    https://github.com/mhaibaraai/search-enhancer
// @version      1.1.0
// @description  为 Google、Bing、百度、DuckDuckGo、搜狗、360 搜索提供无缝翻页、去广告、跳转链接直达真实地址与域名屏蔽
// @author       mhaibaraai
// @license      MIT
// @homepageURL  https://github.com/mhaibaraai/search-enhancer
// @supportURL   https://github.com/mhaibaraai/search-enhancer/issues
// @match        https://www.google.com/search*
// @match        https://www.google.com.hk/search*
// @include      /^https:\/\/www\.google\.[a-z.]+\/search\?/
// @match        https://www.bing.com/search*
// @match        https://cn.bing.com/search*
// @match        https://www.baidu.com/s*
// @match        https://duckduckgo.com/*
// @match        https://www.sogou.com/web*
// @match        https://www.so.com/s*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// @noframes
// ==/UserScript==

;(function () {
  'use strict'

  const PRELOAD_DISTANCE = 1500
  const MAX_PAGES = 30
  const MAX_EMPTY_STREAK = 3
  const POLL_MS = 1000
  const DISABLED_PREFIX = 'disabled:'
  const SETTINGS_KEY = 'settings'
  const PROCESSED_ATTR = 'data-se-done'
  const DEFAULT_SETTINGS = Object.freeze({
    autopager: true,
    removeAds: true,
    redirect: true,
    blockDomains: true,
    blockList: [],
  })

  const byText = (doc, selector, text) =>
    [...doc.querySelectorAll(selector)].find((el) => el.textContent.includes(text))

  const withParams = (url, patch) => {
    const next = new URL(url)
    Object.entries(patch).forEach(([key, value]) =>
      value === null ? next.searchParams.delete(key) : next.searchParams.set(key, value),
    )
    return next.href
  }

  const bumpParam =
    (name, start = 1) =>
    (url) => {
      const current = Number(new URL(url).searchParams.get(name)) || start
      return withParams(url, { [name]: String(current + 1) })
    }

  const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\/[^/]/i.test(value)

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return null
    }
  }

  // Bing 跳转链接的 u 参数为 'a1' + base64url 编码的真实地址
  const decodeBingUrl = (href) => {
    try {
      const u = new URL(href, location.href).searchParams.get('u')
      if (!u || !u.startsWith('a1')) return null
      const base64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/')
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    } catch {
      return null
    }
  }

  const citeUrl = (item) => {
    const text = item.querySelector('cite')?.textContent.trim().split(/\s/)[0]
    if (!text) return null
    const url = /^https?:\/\//i.test(text) ? text : `https://${text}`
    return hostOf(url)?.includes('.') ? url : null
  }

  /**
   * 站点配置
   * - container：结果容器；items：单条结果；title：结果标题链接
   * - anchor：容器内的分页条，存在时状态条与新结果插在它之前
   * - next(doc)：从文档中取下一页链接；fallback(url)：页面缺少分页条时按参数推算下一页
   * - clean(url)：清理会导致返回错误页的参数；mode 'click'：点击站点原生「更多结果」按钮
   * - nativeClass：站点按类名前缀清理未知节点时，置于分隔条与状态条类名首位的原生类名
   * - ads：广告选择器，或接收 root 返回广告元素数组的函数
   * - realUrl(link, item, title)：返回跳转链接对应的真实地址，无法解析时返回 null
   * - hostUrl(item)：标题链接无法还原时，用于域名屏蔽的备用地址
   */
  const SITES = [
    {
      id: 'google',
      test: () => /^www\.google\./.test(location.hostname) && location.pathname === '/search',
      query: 'q',
      container: '#rso',
      items: '#rso > div',
      title: 'a:has(h3)',
      next: (doc) => doc.querySelector('#pnnext'),
      blocked: (doc, url) => url.includes('/sorry/') || !!doc.querySelector('#captcha-form'),
      ads: '#tads, #tadsb, #bottomads',
      hostUrl: citeUrl,
    },
    {
      id: 'bing',
      test: () => /(^|\.)bing\.com$/.test(location.hostname) && location.pathname === '/search',
      query: 'q',
      container: '#b_results',
      items: '#b_results > li.b_algo, #b_results > li.b_ans',
      title: 'h2 a',
      anchor: '#b_results > li.b_pag',
      nativeClass: 'b_msg',
      next: (doc) => doc.querySelector('a.sb_pagN'),
      clean: (url) => withParams(url, { rdr: null, rdrig: null, FPIG: null }),
      ads: '#b_results > li.b_ad, .b_adTop, .b_adBottom',
      realUrl: (link) =>
        link.getAttribute('href')?.includes('/ck/a?') ? decodeBingUrl(link.href) : null,
    },
    {
      id: 'baidu',
      test: () => location.hostname === 'www.baidu.com' && location.pathname === '/s',
      query: 'wd',
      container: '#content_left',
      items: '#content_left > .c-container',
      title: 'h3 a',
      next: (doc) => byText(doc, '#page a', '下一页'),
      blocked: (doc, url) =>
        url.includes('wappass.baidu.com') || !!doc.querySelector('.timeout-feedback'),
      // 广告类名为随机串，按「非结果节点且含推广链接」判定
      ads: (root) =>
        [...root.querySelectorAll('#content_left > :not(.c-container)')].filter((el) =>
          el.querySelector('a[href*="/baidu.php?url="]'),
        ),
      // 仅自然结果的 mu 属性可信，卡片类结果的 mu 常为内部伪地址
      realUrl: (link, item, title) =>
        item.classList.contains('result') && title && link.href === title.href
          ? item.getAttribute('mu')
          : null,
    },
    {
      id: 'duckduckgo',
      test: () =>
        location.hostname === 'duckduckgo.com' && new URL(location.href).searchParams.has('q'),
      query: 'q',
      mode: 'click',
      button: '#more-results',
      items: 'li[data-layout="organic"]',
      title: 'a[data-testid="result-title-a"]',
      ads: 'li[data-layout="ad"]',
    },
    {
      id: 'sogou',
      test: () => location.hostname === 'www.sogou.com' && location.pathname === '/web',
      query: 'query',
      container: '.results',
      items: '.results > .vrwrap, .results > .rb',
      title: 'h3 a',
      next: (doc) => doc.querySelector('#sogou_next'),
      fallback: bumpParam('page'),
      blocked: (doc, url) => url.includes('/antispider/'),
      ads: '.sponsored-ams',
      realUrl: (link, item, title) => {
        if (!title || link.href !== title.href) return null
        if (!link.getAttribute('href')?.startsWith('/link?url=')) return null
        const urls = new Set(
          [...item.querySelectorAll('[data-url]')].map((el) => el.getAttribute('data-url')),
        )
        return urls.size === 1 ? [...urls][0] : null
      },
    },
    {
      id: 'so',
      test: () => location.hostname === 'www.so.com' && location.pathname === '/s',
      query: 'q',
      container: '.result',
      items: '.result > li:not(.res-mediav)',
      title: 'h3 a',
      next: (doc) => doc.querySelector('#snext'),
      fallback: bumpParam('pn'),
      ads: '.res-mediav, #so_kw-ad',
      realUrl: (link) => link.getAttribute('data-mdurl'),
    },
  ]

  const STYLE = `
    .se-divider{display:flex;align-items:center;gap:12px;margin:24px 0;color:#70757a;font:13px/1.6 system-ui,sans-serif;list-style:none}
    .se-line{flex:1;border-top:1px dashed #c7c7c7}
    .se-divider a{color:#1a73e8;text-decoration:none}
    .se-divider a:hover{text-decoration:underline}
    .se-status{margin:16px 0 32px;text-align:center;color:#70757a;font:13px/1.6 system-ui,sans-serif}
    .se-status[data-state="idle"]{visibility:hidden}
    .se-status button{margin-left:8px;padding:2px 10px;border:1px solid #c7c7c7;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
    @media (prefers-color-scheme: dark){.se-divider,.se-status{color:#9aa0a6}.se-divider a{color:#8ab4f8}}
  `

  const PANEL_STYLE = `
    :host{all:initial}
    .mask{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:14px/1.6 system-ui,-apple-system,sans-serif;color:#1f1f1f}
    .panel{width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:20px;border-radius:12px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25)}
    h2{margin:0 0 12px;font-size:16px}
    label.row{display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer}
    .hint{margin:12px 0 4px;color:#5f6368;font-size:12px}
    textarea{width:100%;box-sizing:border-box;min-height:120px;padding:8px;border:1px solid #c7c7c7;border-radius:6px;font:13px/1.5 ui-monospace,monospace;color:inherit;background:transparent;resize:vertical}
    .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
    button{padding:6px 16px;border:1px solid #c7c7c7;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}
    button.primary{border-color:#1a73e8;background:#1a73e8;color:#fff}
    .error{min-height:1.4em;margin-top:4px;color:#d93025;font-size:12px}
    @media (prefers-color-scheme: dark){.mask{color:#e8eaed}.panel{background:#202124}.hint{color:#9aa0a6}}
  `

  const site = SITES.find((s) => s.test())
  if (!site) return

  const loadSettings = () => {
    const stored = GM_getValue(SETTINGS_KEY, {})
    const merged = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
    const blockList = Array.isArray(merged.blockList)
      ? merged.blockList.filter((d) => typeof d === 'string')
      : []
    return Object.freeze({ ...merged, blockList })
  }

  const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/

  // 解析屏蔽列表：每行一个，允许粘贴完整网址，返回 { domains, invalid }
  const parseBlockList = (text) => {
    const entries = text
      .split(/[\n,，]+/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean)
      .map((line) => {
        const bare = line.replace(/^\*\./, '')
        const host = /\s/.test(bare)
          ? null
          : hostOf(/^[a-z]+:\/\//.test(bare) ? bare : `http://${bare}`)
        return { line, host: host && host.replace(/^www\./, '') }
      })
    const isValid = (e) => !!e.host && DOMAIN_PATTERN.test(e.host)
    return {
      domains: [...new Set(entries.filter(isValid).map((e) => e.host))],
      invalid: entries.filter((e) => !isValid(e)).map((e) => e.line),
    }
  }

  const settings = loadSettings()
  const disabledKey = DISABLED_PREFIX + location.hostname
  const enabled = !GM_getValue(disabledKey, false)

  const SWITCHES = [
    ['autopager', '无缝翻页'],
    ['removeAds', '去广告'],
    ['redirect', '跳转链接直达真实地址'],
    ['blockDomains', '屏蔽指定域名'],
  ]

  const openSettings = () => {
    if (document.getElementById('se-settings-host')) return
    const host = document.createElement('div')
    host.id = 'se-settings-host'
    const root = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = PANEL_STYLE
    const mask = document.createElement('div')
    mask.className = 'mask'
    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Search Enhancer 设置')

    const heading = document.createElement('h2')
    heading.textContent = 'Search Enhancer 设置'

    const inputs = SWITCHES.map(([key, text]) => {
      const label = document.createElement('label')
      label.className = 'row'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = settings[key]
      label.append(input, document.createTextNode(text))
      return { key, label, input }
    })

    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = '屏蔽域名：每行一个，同时屏蔽其子域名，如 csdn.net'
    const textarea = document.createElement('textarea')
    textarea.value = settings.blockList.join('\n')
    textarea.spellcheck = false
    const error = document.createElement('div')
    error.className = 'error'

    const close = () => host.remove()
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    cancel.addEventListener('click', close)
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'primary'
    save.textContent = '保存并刷新'
    save.addEventListener('click', () => {
      const { domains, invalid } = parseBlockList(textarea.value)
      if (invalid.length) {
        error.textContent = `无法识别：${invalid.slice(0, 3).join('、')}`
        return
      }
      const switches = Object.fromEntries(inputs.map(({ key, input }) => [key, input.checked]))
      GM_setValue(SETTINGS_KEY, { ...switches, blockList: domains })
      location.reload()
    })

    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.append(cancel, save)
    panel.append(heading, ...inputs.map((i) => i.label), hint, textarea, error, actions)
    mask.append(panel)
    mask.addEventListener('click', (event) => event.target === mask && close())
    root.addEventListener('keydown', (event) => event.key === 'Escape' && close())
    root.append(style, mask)
    document.documentElement.append(host)
    textarea.focus()
  }

  GM_registerMenuCommand('设置', openSettings)
  GM_registerMenuCommand(
    enabled ? '在此站点禁用 Search Enhancer' : '在此站点启用 Search Enhancer',
    () => {
      GM_setValue(disabledKey, enabled)
      location.reload()
    },
  )

  if (!enabled) return

  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  // 隐藏而非删除，避免破坏站点前端框架对节点的引用
  const hide = (el) => el.style.setProperty('display', 'none', 'important')

  const removeAds = (root) => {
    if (!settings.removeAds || !site.ads) return
    const ads = typeof site.ads === 'function' ? site.ads(root) : root.querySelectorAll(site.ads)
    ads.forEach(hide)
  }

  const titleOf = (item) => (site.title && item.querySelector(site.title)) || null

  const realUrlOf = (link, item, title) => {
    const url = site.realUrl?.(link, item, title)
    return isHttpUrl(url) ? url : null
  }

  // 去重键：还原后的真实地址，否则用标题链接（跳转链接本身也能区分结果）
  const resultKey = (item) => {
    const title = titleOf(item)
    return title ? (realUrlOf(title, item, title) ?? title.href) : null
  }

  // 用于域名屏蔽的地址：仍是站内跳转链接时改用站点备用地址（如 Google 的 cite）
  const hostUrl = (item) => {
    const key = resultKey(item)
    const isRedirect = !key || hostOf(key) === location.hostname
    return isRedirect ? (site.hostUrl?.(item) ?? key) : key
  }

  const isBlocked = (item) => {
    if (!settings.blockDomains || !settings.blockList.length) return false
    const host = hostOf(hostUrl(item))
    return !!host && settings.blockList.some((d) => host === d || host.endsWith(`.${d}`))
  }

  const applyRedirect = (item) => {
    if (!settings.redirect || !site.realUrl) return
    const title = titleOf(item)
    item.querySelectorAll('a[href]').forEach((link) => {
      const real = realUrlOf(link, item, title)
      if (real) link.setAttribute('href', real)
    })
  }

  // 统一处理单条结果，返回是否保留
  const processItem = (item) => {
    item.setAttribute(PROCESSED_ATTR, '')
    if (isBlocked(item)) return false
    applyRedirect(item)
    return true
  }

  // 处理页面上尚未处理的结果，屏蔽项隐藏
  const processExisting = () =>
    [...document.querySelectorAll(site.items)]
      .filter((item) => !item.hasAttribute(PROCESSED_ATTR))
      .filter((item) => !processItem(item))
      .forEach(hide)

  const createNode = (container, className) => {
    const tag = /^(UL|OL)$/.test(container.tagName) ? 'li' : 'div'
    const el = document.createElement(tag)
    el.className = [site.nativeClass, className].filter(Boolean).join(' ')
    return el
  }

  const setStatus = (el, state, text, action) => {
    el.dataset.state = state
    el.textContent = text
    if (action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.label
      button.addEventListener('click', action.onClick)
      el.appendChild(button)
    }
  }

  // 节流绑定滚动与缩放事件，返回 [立即触发, 解绑]
  const bindScroll = (fn, wait) => {
    let last = 0
    let timer = null
    const run = () => {
      last = Date.now()
      fn()
    }
    const handler = () => {
      const remaining = wait - (Date.now() - last)
      clearTimeout(timer)
      if (remaining <= 0) run()
      else timer = setTimeout(run, remaining)
    }
    window.addEventListener('scroll', handler, { passive: true })
    window.addEventListener('resize', handler, { passive: true })
    const unbind = () => {
      clearTimeout(timer)
      window.removeEventListener('scroll', handler)
      window.removeEventListener('resize', handler)
    }
    return [handler, unbind]
  }

  const nearBottom = (el) => el.getBoundingClientRect().top < window.innerHeight + PRELOAD_DISTANCE

  const currentQuery = () => new URL(location.href).searchParams.get(site.query)

  // 原生「更多结果」按钮模式（DuckDuckGo），新结果由站点脚本渲染，监听后处理
  const startClickMode = () => {
    let scheduled = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        removeAds(document)
        processExisting()
      })
    })
    observer.observe(document.body, { childList: true, subtree: true })
    removeAds(document)
    processExisting()

    if (!settings.autopager) return { alive: () => true, stop: () => observer.disconnect() }

    const [check, unbind] = bindScroll(() => {
      const button = document.querySelector(site.button)
      if (button && !button.disabled && nearBottom(button)) button.click()
    }, 300)
    check()
    return {
      alive: () => true,
      stop: () => {
        observer.disconnect()
        unbind()
      },
    }
  }

  const resolveNext = (doc, baseUrl) => {
    const link = site.next(doc)
    const href = link && link.getAttribute('href')
    if (href) {
      const absolute = new URL(href, baseUrl).href
      return site.clean ? site.clean(absolute) : absolute
    }
    const hasResults = doc.querySelectorAll(site.items).length > 0
    return site.fallback && hasResults ? site.fallback(baseUrl) : null
  }

  const createDivider = (container, pageNum, url, blockedCount) => {
    const el = createNode(container, 'se-divider')
    el.dataset.url = url
    const label = document.createElement('span')
    const blockedText = blockedCount ? `已屏蔽 ${blockedCount} 条 · ` : ''
    label.textContent = `第 ${pageNum} 页 · ${blockedText}`
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = '打开原页面'
    label.appendChild(link)
    const line = () => Object.assign(document.createElement('span'), { className: 'se-line' })
    el.append(line(), label, line())
    return el
  }

  // 导入下一页结果：去重、屏蔽、重定向，返回 { nodes, blockedCount }
  const importItems = (items, seen) =>
    items.reduce(
      (acc, item) => {
        const node = document.importNode(item, true)
        node.querySelectorAll('script').forEach((script) => script.remove())
        const key = resultKey(node)
        if (key && seen.has(key)) return acc
        if (key) seen.add(key)
        if (!processItem(node)) return { ...acc, blockedCount: acc.blockedCount + 1 }
        return { ...acc, nodes: [...acc.nodes, node] }
      },
      { nodes: [], blockedCount: 0 },
    )

  // 抓取下一页 HTML 并拼接到结果容器
  const startFetchMode = () => {
    const container = document.querySelector(site.container)
    if (!container) return { alive: () => false, stop: () => {} }

    removeAds(document)
    processExisting()
    if (!settings.autopager) return { alive: () => container.isConnected, stop: () => {} }

    const anchor = site.anchor ? container.querySelector(site.anchor) : null
    const status = anchor
      ? createNode(container, 'se-status')
      : createNode(document.body, 'se-status')
    status.dataset.state = 'idle'
    if (anchor) container.insertBefore(status, anchor)
    else container.after(status)

    const firstUrl = location.href
    const seenResults = new Set(
      [...container.querySelectorAll(site.items)].map(resultKey).filter(Boolean),
    )
    const loadedUrls = new Set([firstUrl])
    const state = {
      nextUrl: resolveNext(document, firstUrl),
      pageNum: 1,
      loading: false,
      done: false,
      emptyStreak: 0,
    }
    let dividers = []
    let inserted = []
    let stopped = false

    const syncUrl = () => {
      const passed = dividers.filter((d) => d.getBoundingClientRect().top < window.innerHeight / 2)
      const url = passed.length ? passed[passed.length - 1].dataset.url : firstUrl
      if (url !== location.href) history.replaceState(history.state, '', url)
    }

    const finish = (text, action) => {
      state.done = true
      setStatus(status, 'done', text, action)
    }

    const load = async () => {
      if (state.loading || state.done) return
      if (!state.nextUrl || loadedUrls.has(state.nextUrl)) return finish('已到最后一页')
      if (state.pageNum >= MAX_PAGES) return finish(`已自动加载 ${MAX_PAGES} 页，请手动翻页`)

      const url = state.nextUrl
      state.loading = true
      setStatus(status, 'loading', `正在加载第 ${state.pageNum + 1} 页…`)

      try {
        const response = await fetch(url, { credentials: 'include' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html')
        if (stopped) return

        if (site.blocked?.(doc, response.url) || !doc.querySelector(site.container)) {
          return finish('需要人机验证或页面结构已变化', {
            label: '手动打开下一页',
            onClick: () => window.open(url, '_blank', 'noopener'),
          })
        }

        const { nodes, blockedCount } = importItems(
          [...doc.querySelectorAll(site.items)],
          seenResults,
        )
        loadedUrls.add(url)
        if (!nodes.length && !blockedCount) return finish('已到最后一页')

        state.pageNum += 1
        state.nextUrl = resolveNext(doc, response.url)
        const divider = createDivider(container, state.pageNum, url, blockedCount)
        const fragment = document.createDocumentFragment()
        fragment.append(divider, ...nodes)
        container.insertBefore(fragment, anchor ? status : null)
        dividers = [...dividers, divider]
        inserted = [...inserted, divider, ...nodes]
        state.emptyStreak = nodes.length ? 0 : state.emptyStreak + 1
        if (state.emptyStreak >= MAX_EMPTY_STREAK) {
          state.loading = false
          return finish(`连续 ${MAX_EMPTY_STREAK} 页结果均被屏蔽`, {
            label: '继续加载',
            onClick: () => {
              state.done = false
              state.emptyStreak = 0
              load()
            },
          })
        }
        setStatus(status, 'idle', '')
      } catch (error) {
        console.error('[search-enhancer]', error)
        setStatus(status, 'error', `加载失败：${error.message}`, {
          label: '重试',
          onClick: () => load(),
        })
        state.loading = false
        return
      }

      state.loading = false
      check()
    }

    const [check, unbind] = bindScroll(() => {
      syncUrl()
      if (status.dataset.state !== 'error' && nearBottom(status)) load()
    }, 200)
    check()

    // 换词后移除本实例插入的旧结果，避免残留分隔条干扰地址栏同步
    const stop = () => {
      stopped = true
      unbind()
      status.remove()
      inserted.forEach((node) => node.remove())
    }

    return { alive: () => container.isConnected, stop }
  }

  const start = () => (site.mode === 'click' ? startClickMode() : startFetchMode())

  // 站内无刷新换词或结果容器被替换时重启；站点延迟注入的广告在轮询中清理
  let instance = start()
  let query = currentQuery()
  setInterval(() => {
    removeAds(document)
    const latest = currentQuery()
    if (latest === query && instance.alive()) return
    query = latest
    instance.stop()
    instance = start()
  }, POLL_MS)
})()

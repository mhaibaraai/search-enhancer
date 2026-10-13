// ==UserScript==
// @name         Search AutoPager - 搜索引擎无缝翻页
// @namespace    https://github.com/mhaibaraai/search-autopager
// @version      1.0.0
// @description  为 Google、Bing、百度、DuckDuckGo、搜狗、360 搜索提供滚动自动加载下一页，带页码分隔条、地址栏同步与按站点开关
// @author       mhaibaraai
// @license      MIT
// @homepageURL  https://github.com/mhaibaraai/search-autopager
// @supportURL   https://github.com/mhaibaraai/search-autopager/issues
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
  const QUERY_POLL_MS = 1000
  const STORAGE_PREFIX = 'disabled:'

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

  /**
   * 站点配置
   * - container：结果容器；items：单条结果；anchor：容器内的分页条，存在时状态条与新结果插在它之前
   * - next(doc)：从文档中取下一页链接；fallback(url)：页面缺少分页条时按参数推算下一页
   * - clean(url)：清理会导致返回错误页的参数；mode 'click'：点击站点原生「更多结果」按钮
   * - nativeClass：站点按类名前缀清理未知节点时，置于分隔条与状态条类名首位的原生类名
   */
  const SITES = [
    {
      id: 'google',
      test: () => /^www\.google\./.test(location.hostname) && location.pathname === '/search',
      query: 'q',
      container: '#rso',
      items: '#rso > div',
      next: (doc) => doc.querySelector('#pnnext'),
      blocked: (doc, url) => url.includes('/sorry/') || !!doc.querySelector('#captcha-form'),
    },
    {
      id: 'bing',
      test: () => /(^|\.)bing\.com$/.test(location.hostname) && location.pathname === '/search',
      query: 'q',
      container: '#b_results',
      items: '#b_results > li.b_algo, #b_results > li.b_ans',
      anchor: '#b_results > li.b_pag',
      nativeClass: 'b_msg',
      next: (doc) => doc.querySelector('a.sb_pagN'),
      clean: (url) => withParams(url, { rdr: null, rdrig: null, FPIG: null }),
    },
    {
      id: 'baidu',
      test: () => location.hostname === 'www.baidu.com' && location.pathname === '/s',
      query: 'wd',
      container: '#content_left',
      items: '#content_left > .c-container',
      next: (doc) => byText(doc, '#page a', '下一页'),
      blocked: (doc, url) =>
        url.includes('wappass.baidu.com') || !!doc.querySelector('.timeout-feedback'),
    },
    {
      id: 'duckduckgo',
      test: () =>
        location.hostname === 'duckduckgo.com' && new URL(location.href).searchParams.has('q'),
      query: 'q',
      mode: 'click',
      button: '#more-results',
    },
    {
      id: 'sogou',
      test: () => location.hostname === 'www.sogou.com' && location.pathname === '/web',
      query: 'query',
      container: '.results',
      items: '.results > .vrwrap, .results > .rb',
      next: (doc) => doc.querySelector('#sogou_next'),
      fallback: bumpParam('page'),
      blocked: (doc, url) => url.includes('/antispider/'),
    },
    {
      id: 'so',
      test: () => location.hostname === 'www.so.com' && location.pathname === '/s',
      query: 'q',
      container: '.result',
      items: '.result > li:not(.res-mediav)',
      next: (doc) => doc.querySelector('#snext'),
      fallback: bumpParam('pn'),
    },
  ]

  const STYLE = `
    .sap-divider{display:flex;align-items:center;gap:12px;margin:24px 0;color:#70757a;font:13px/1.6 system-ui,sans-serif;list-style:none}
    .sap-line{flex:1;border-top:1px dashed #c7c7c7}
    .sap-divider a{color:#1a73e8;text-decoration:none}
    .sap-divider a:hover{text-decoration:underline}
    .sap-status{margin:16px 0 32px;text-align:center;color:#70757a;font:13px/1.6 system-ui,sans-serif}
    .sap-status[data-state="idle"]{visibility:hidden}
    .sap-status button{margin-left:8px;padding:2px 10px;border:1px solid #c7c7c7;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
    @media (prefers-color-scheme: dark){.sap-divider,.sap-status{color:#9aa0a6}.sap-divider a{color:#8ab4f8}}
  `

  const site = SITES.find((s) => s.test())
  if (!site) return

  const storageKey = STORAGE_PREFIX + location.hostname
  const enabled = !GM_getValue(storageKey, false)

  GM_registerMenuCommand(enabled ? '在此站点禁用无缝翻页' : '在此站点启用无缝翻页', () => {
    GM_setValue(storageKey, enabled)
    location.reload()
  })

  if (!enabled) return

  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

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

  // 原生「更多结果」按钮模式（DuckDuckGo）
  const startClickMode = () => {
    const [check, unbind] = bindScroll(() => {
      const button = document.querySelector(site.button)
      if (button && !button.disabled && nearBottom(button)) button.click()
    }, 300)
    check()
    return { alive: () => true, stop: unbind }
  }

  const resultKey = (item) => {
    const link = item.querySelector('a[href^="http"], a[href^="/"]')
    return link ? link.href : null
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

  const createDivider = (container, pageNum, url) => {
    const el = createNode(container, 'sap-divider')
    el.dataset.url = url
    const label = document.createElement('span')
    label.textContent = `第 ${pageNum} 页 · `
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = '打开原页面'
    label.appendChild(link)
    const line = () => Object.assign(document.createElement('span'), { className: 'sap-line' })
    el.append(line(), label, line())
    return el
  }

  const importItems = (items, seen) =>
    items
      .filter((item) => {
        const key = resultKey(item)
        if (!key) return true
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((item) => {
        const node = document.importNode(item, true)
        node.querySelectorAll('script').forEach((script) => script.remove())
        return node
      })

  // 抓取下一页 HTML 并拼接到结果容器
  const startFetchMode = () => {
    const container = document.querySelector(site.container)
    if (!container) return { alive: () => false, stop: () => {} }

    const anchor = site.anchor ? container.querySelector(site.anchor) : null
    const status = anchor
      ? createNode(container, 'sap-status')
      : createNode(document.body, 'sap-status')
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

        const nodes = importItems([...doc.querySelectorAll(site.items)], seenResults)
        loadedUrls.add(url)
        if (!nodes.length) return finish('已到最后一页')

        state.pageNum += 1
        const divider = createDivider(container, state.pageNum, url)
        const fragment = document.createDocumentFragment()
        fragment.append(divider, ...nodes)
        container.insertBefore(fragment, anchor ? status : null)
        dividers = [...dividers, divider]
        inserted = [...inserted, divider, ...nodes]

        state.nextUrl = resolveNext(doc, response.url)
        setStatus(status, 'idle', '')
      } catch (error) {
        console.error('[search-autopager]', error)
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

  // 站内无刷新换词或结果容器被替换时重启
  let instance = start()
  let query = currentQuery()
  setInterval(() => {
    const latest = currentQuery()
    if (latest === query && instance.alive()) return
    query = latest
    instance.stop()
    instance = start()
  }, QUERY_POLL_MS)
})()

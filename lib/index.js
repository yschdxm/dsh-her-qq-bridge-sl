// dsh-her-qq-bridge-sl · 主入口（SnowLuma / OneBot v11）
//
// QQ 桥接：SnowLuma OneBot 推送 → kernel.ingest（只入库+弹通知，不注入会话）；
// 内核出站（app_send/主动）→ 分类器出站审核 → 发 QQ。
// 只做协议适配 + 安全分类器，不碰内核逻辑。
// ★ 分类器只管出站（2026-10-25 决策，计划 4.2）：入站不做拦截。

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createOnebot } from './onebot.js'
import { createClassifiers, DEFAULT_RULES } from './classifier.js'

const __dir = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-her-qq-bridge-sl'
export const inject = ['herKernel', 'tools', 'webServer', 'llm']

export function apply(ctx) {
  const logLine = (s) => { try { appendFileSync('/tmp/kernel-agent.log', new Date().toISOString() + ' ' + s + '\n') } catch (e) { /* ignore */ } }
  const diag = (msg) => {
    try { ctx.logger?.info?.(`[qq-bridge-sl] ${msg}`) } catch (e) { /* ignore */ }
    logLine(`[qq-bridge-sl] ${msg}`)
  }
  diag('apply 开始')

  // 读审核规则
  let toolRules = {}
  try {
    toolRules = JSON.parse(readFileSync(join(__dir, 'rules.json'), 'utf8'))
  } catch (e) {
    diag('读 rules.json 失败，用默认规则：' + (e && e.message))
    toolRules = { send_group_msg: DEFAULT_RULES, send_private_msg: DEFAULT_RULES }
  }
  const classifiers = createClassifiers(toolRules, {
    llm: (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) || ctx.llm,
    diag,
  })
  // token：优先 ops/onebot-token.txt；优先从 SnowLuma onebot.json 读 accessToken（与容器一致）
  function loadOnebotToken() {
    try {
      const p = '/mnt/nvme/agent/snowluma/data/config/onebot.json'
      if (existsSync(p)) {
        const ob = JSON.parse(readFileSync(p, 'utf8'))
        const t = ob?.networks?.httpServers?.[0]?.accessToken
          || ob?.networks?.wsServers?.[0]?.accessToken
          || ''
        if (t) return String(t)
      }
    } catch (e) { /* ignore */ }
    try { return readFileSync('/mnt/nvme/agent/dsh/ops/onebot-token.txt', 'utf8').trim() } catch (e) { /* ignore */ }
    return ''
  }
  const _onebotToken = loadOnebotToken()
  diag('OneBot token 已加载（长度 ' + _onebotToken.length + '）')
  const napcat = createOnebot({ config: { onebot: { httpBase: 'http://127.0.0.1:3000', token: _onebotToken } }, diag })

  // 注册 QQ 渠道（通知规则/App 行为/使用注意由 QQ 桥接自己定）
  const kernel = (typeof ctx.get === 'function' ? ctx.get('herKernel') : undefined) || ctx.herKernel

  // 工具：qq_sl_api——SnowLuma 只读白名单（OneBot）（发消息走内核出站分类器，不给直接发送的口子）
  // ⚠️ 只挂角色会话（kernel.mountTool → agent.ctx），不全局注册——全局会泄漏给其他工作区的会话
  // SnowLuma / OneBot 只读白名单（以 SnowLuma 动作为准；nc 兼容名一并保留）
  // 仅允许查询，不允许直接发送/管理（发消息一律走内核出站分类器）
  const NAPCAT_READ_WHITELIST = new Set([
    'get_login_info', 'get_status', 'get_version_info', 'get_self_info',
    'get_friend_list', 'get_friend_info',
    'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info', 'get_group_honor_info',
    'get_msg', 'get_friend_msg_history', 'get_group_msg_history',
    'get_image', 'get_record', 'get_video',
    'can_send_image', 'can_send_record', 'get_model_show',
    // SnowLuma extended（只读；不支持的调用会返回失败，不影响其它）
    'extended/get_essence_msg_list',
    'extended/_get_group_notice',
    'extended/get_forward_msg',
    'extended/fetch_custom_face',
    'extended/fetch_custom_face_detail',
    'extended/fetch_sys_faces',
    'extended/fetch_ptt_text',
    'fetch_custom_face',
    'fetch_sys_faces',
    'fetch_custom_face_detail',
    'fetch_sys_faces',
    'extended/get_collection_list',
    'extended/download_file',
    'extended/get_doubt_friends_add_request',
    'extended/get_group_ignore_add_request',
    'group-file/get_group_root_files',
    'group-file/get_group_files_by_folder',
    'group-file/get_group_file_url',
    'group-file/get_group_file_system_info',
    // NapCat 风格兼容名
    'get_essence_msg_list',
    'fetch_essence_msg_list',
    'get_group_announce',
    'get_group_notice',
    'fetch_group_announce',
    'get_forward_msg',
    'get_group_forward_msg',
    'get_group_root_file',
    'get_group_dir_files',
    'get_cookies', 'get_csrf_token', 'get_credentials',
  ])
  const napcatToolDef = {
    name: 'qq_sl_api',
    description: '查 QQ 侧信息（登录/好友/群/历史消息等只读接口）。查表情包：extended/fetch_custom_face、extended/fetch_sys_faces。发消息不要用这个——用 app_send。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '接口名，如 get_friend_list / extended/fetch_custom_face' },
        params: { type: 'object', description: '接口参数（对象），如 {"user_id":123}' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const action = String(a.action || '')
      if (!NAPCAT_READ_WHITELIST.has(action)) {
        return { ok: false, error: '不在只读白名单内', allowed: [...NAPCAT_READ_WHITELIST] }
      }
      return await napcat.callOneBot(action, a.params && typeof a.params === 'object' ? a.params : {})
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
  }
  // 工具结果必须是 DSH 能接受的 lossless JSON：只返回 string/number/boolean/null，禁止 undefined / raw 原始包
  function plainJson(v) {
    return JSON.parse(JSON.stringify(v))
  }
  const customFaceToolDef = {
    name: 'qq_custom_faces',
    description: '查表情：系统包 + 收藏。keyword 过滤。发送：sys 用 face_id 给 app_send.sticker；收藏用 image=url，或先 qq_collect_face。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：按名称/描述过滤' },
        limit: { type: 'number' },
        pack: { type: 'string', description: '可选：只看系统包名，如 超级表情' },
        source: { type: 'string', description: 'sys|custom|all，默认 all' },
      },
      additionalProperties: false,
    },
    execute: async (a) => {
      const kw = String(a.keyword || '').trim()
      const packFilter = String(a.pack || '').trim()
      const only = String(a.source || 'all').toLowerCase()
      const limit = Math.min(80, Math.max(1, Number(a.limit) || 30))
      const items = []

      if (only === 'all' || only === 'sys') {
        try {
          const r = await napcat.callOneBot('fetch_sys_faces', {})
          const packs = (r && r.data && r.data.packs) || []
          for (const p of packs) {
            if (packFilter && String(p.pack_name || '') !== packFilter) continue
            for (const e of (p.emojis || [])) {
              const name = String(e.q_des || e.emoji_name || '').replace(/^\//, '')
              if (kw && !name.includes(kw) && String(e.q_sid || '') !== kw && String(e.em_code || '') !== kw) continue
              const sid = String(e.q_sid || e.em_code || '')
              if (!sid) continue
              // 已知坏 id：服务端 sysemojis cfg not found（如 92）
              if (sid === '92') continue
              items.push({
                source: 'sys',
                pack: String(p.pack_name || ''),
                name,
                face_id: sid,
                is_super: e.is_super === true,
                sticker: sid,
              })
            }
          }
        } catch (e) { /* ignore */ }
      }

      if (only === 'all' || only === 'custom') {
        try {
          const r = await napcat.callOneBot('fetch_custom_face_detail', { count: 48 })
          const list = Array.isArray(r && r.data) ? r.data : (Array.isArray(r) ? r : [])
          for (const it of list) {
            if (!it || typeof it !== 'object') continue
            const desc = String(it.desc || '')
            if (kw && !desc.includes(kw)) continue
            const url = String(it.url || '')
            items.push({
              source: 'custom',
              pack: '收藏',
              name: desc || '(无备注)',
              emoji_id: String(it.emoji_id || ''),
              url,
              md5: String(it.md5 || ''),
              sticker: url,
            })
          }
        } catch (e) { /* ignore */ }
      }

      return plainJson({
        ok: true,
        count: Math.min(items.length, limit),
        total: items.length,
        items: items.slice(0, limit),
        note: 'sys 用 face_id→app_send.sticker；custom 用 url→app_send.image。收藏空时用 qq_collect_face。',
      })
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(plainJson(v), null, 2) }] },
  }
  // 收藏表情：add_custom_face（官方参数 file = image）；只返回纯 JSON，避免 lossless 校验失败
  const collectFaceToolDef = {
    name: 'qq_collect_face',
    description: '把一张图加入 QQ 收藏表情。file=图片 URL。成功返回 emoji_id；可用 desc 写备注。之后 qq_custom_faces source=custom 能查到。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '图片 URL' },
        desc: { type: 'string', description: '可选备注' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const file = String(a.file || '').trim()
      if (!file) return plainJson({ ok: false, error: '缺少 file' })
      const r = await napcat.callOneBot('add_custom_face', { file })
      const ok = !!(r && (r.status === 'ok' || r.retcode === 0))
      const data = r && r.data
      const emojiId = String((data && data.emoji_id) || (typeof data === 'string' ? data : '') || '')
      let descSet = ''
      if (ok && a.desc && emojiId) {
        try {
          const m = await napcat.callOneBot('modify_custom_face', { emoji_id: emojiId, desc: String(a.desc) })
          if (m && (m.status === 'ok' || m.retcode === 0)) descSet = String(a.desc)
        } catch (e) { /* ignore */ }
      }
      if (!ok) {
        return plainJson({ ok: false, error: String((r && (r.wording || r.error)) || '收藏失败').slice(0, 200) })
      }
      return plainJson({ ok: true, emoji_id: emojiId, desc: descSet })
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(plainJson(v), null, 2) }] },
  }
  if (kernel && typeof kernel.mountTool === 'function') {
    const r = kernel.mountTool(napcatToolDef, { channels: ['qq-group', 'qq-private'] })
    diag('qq_sl_api 已交内核按角色挂载' + (r && r.ok === false ? '：' + r.error : ''))
    const r2 = kernel.mountTool(customFaceToolDef, { channels: ['qq-group', 'qq-private'] })
    diag('qq_custom_faces 已交内核按角色挂载' + (r2 && r2.ok === false ? '：' + r2.error : ''))
    const r3 = kernel.mountTool(collectFaceToolDef, { channels: ['qq-group', 'qq-private'] })
    diag('qq_collect_face 已交内核按角色挂载' + (r3 && r3.ok === false ? '：' + r3.error : ''))
  } else {
    diag('qq_sl_api 无法挂载：kernel.mountTool 不可用（旧版内核？）')
  }

  if (kernel && kernel.registerChannel) {
    kernel.registerChannel({
      type: 'qq-group',
      notify: {
        atOnly: true,
        silentMinutes: 5,
        format: '工具：QQ 群 {target} 有 {count} 条消息',
        // 群渠道注入：保留冷却与日上限（与私聊互不影响）
        injectEnabled: true,
        injectCooldownMinutes: 10,
        injectDailyCap: 8,
        injectRespectQuiet: true,
      },
      app: { pageSize: 10, autoExitMinutes: 30 },
      notes: '群消息仅 @她 时弹出通知（其余保留未读角标）。读取与发送均通过 App 工具；发送工具为唯一送达路径，会话内正文不写入渠道。发送受出站安全策略约束；图片与表情经 image / sticker 参数提交。qq_sl_api 为只读接口。',
      ui: { tabId: 'qq', tabLabel: 'QQ', order: 10 },
    })
    kernel.registerChannel({
      type: 'qq-private',
      notify: {
        dmPriority: true,
        format: '工具：QQ 私聊 {target} 有 {count} 条消息',
        // 主人私聊：无冷却、无日上限、不受夜间静默
        injectEnabled: true,
        injectCooldownMinutes: 0,
        injectDailyCap: 0,
        injectRespectQuiet: false,
      },
      app: { pageSize: 10 },
      notes: '读取与发送均通过 App 工具；发送工具为唯一送达路径，会话内正文不写入渠道。发送受出站安全策略约束；图片与表情经 image / sticker 参数提交。qq_sl_api 为只读接口。私聊通知优先（不静默）；其他渠道存在延迟静默。',
      ui: { tabId: 'qq', tabLabel: 'QQ', order: 10 },
    })
    diag('QQ 渠道已注册（qq-group / qq-private）')
  }

  // 入站：SnowLuma OneBot 事件 → kernel.ingest（只入库+通知；分类器不拦入站——计划 4.2）
  // key: `${channel}/${target}` → 最近一条入站 QQ message_id（用于 mark_*_as_read）
  const lastInboundMsgId = new Map()
  async function ingestFromNapcat(ev) {
    const msg = napcat.normalizeEvent(ev)
    if (!msg) {
      // meta 心跳等：仅留档
      if (ev && ev.post_type && ev.post_type !== 'meta_event') {
        diag('忽略事件：pt=' + ev.post_type + ' nt=' + (ev.notice_type || '') + ' rt=' + (ev.request_type || ''))
      }
      return
    }
    // 仅记录来自用户的数字 message_id（排除 notice-*/reply-* 等本地 id）
    if (msg.fromUser && /^\d+$/.test(String(msg.msg_id || ''))) {
      lastInboundMsgId.set(msg.channel + '/' + msg.target, String(msg.msg_id))
    }
    // 图片仅有 file 无 url 时，尝试 OneBot get_image 解析可访问地址
    if (msg.media && Array.isArray(msg.media.images)) {
      for (const im of msg.media.images) {
        if (im && !im.url && im.file) {
          try {
            const r = await napcat.callOneBot('get_image', { file: im.file })
            const data = r && (r.data || r)
            const url = String((data && (data.url || data.file)) || '')
            if (/^https?:\/\//i.test(url)) im.url = url
            else if (typeof data === 'string' && /^https?:\/\//i.test(data)) im.url = data
          } catch (e) { /* 保留无 url，后续直读会跳过 */ }
        }
      }
    }
    // 引用回复：拉被引用原文，写入 media.quote，并拼进 content
    if (msg.media && msg.media.quote && msg.media.quote.id) {
      try {
        const r = await napcat.callOneBot('get_msg', { message_id: Number(msg.media.quote.id) })
        const data = r && (r.data != null ? r.data : r)
        const rawMsg = data && (data.message || data.raw_message || '')
        const qText = typeof rawMsg === 'string'
          ? napcat.extractTextFromCQ
            ? napcat.extractTextFromCQ(rawMsg)
            : rawMsg.replace(/\[CQ:[^\]]*\]/g, '')
          : (typeof napcat.extractText === 'function' ? napcat.extractText(rawMsg) : '')
        const qSender = String((data && data.sender && (data.sender.nickname || data.sender.card)) || (data && data.nickname) || '')
        const qTime = Number((data && data.time) || 0) || null
        msg.media.quote = {
          id: String(msg.media.quote.id),
          content: String(qText || '').slice(0, 500),
          sender: qSender,
          time: qTime,
        }
        if (msg.media.quote.content) {
          msg.content = '[引用 ' + (qSender || '对方') + '：' + msg.media.quote.content.slice(0, 120) + ']\n' + String(msg.content || '')
        }
      } catch (e) {
        diag('拉取引用原文失败：' + (e && e.message))
        msg.media.quote = { id: String(msg.media.quote.id), content: '', sender: '', time: null }
      }
    }
    diag('入站：' + msg.channel + '/' + msg.target + ' ' + msg.sender + ': ' + String(msg.content).slice(0, 40)
      + (msg.media ? ' media=' + JSON.stringify(msg.media).slice(0, 120) : ''))
    if (!String(msg.content || '').trim()) { diag('空内容消息跳过'); return }
    if (kernel && kernel.ingest) await kernel.ingest(msg)
    // 入站即向 QQ 服务器报「已读回执」（SsoReadedReport），清手机客户端角标。
    // 注意：这是协议层 read report，不是本地 messages.db。
    if (msg.channel === 'qq-group' || msg.channel === 'qq-private') {
      const mid = /^\d+$/.test(String(msg.msg_id || '')) ? String(msg.msg_id) : null
      try { await markQqRead(msg.channel, msg.target, { messageIds: mid ? [mid] : [], source: 'ingest' }) } catch (e) { /* ignore */ }
    }
  }

  // 向 QQ 服务器报已读回执（SsoReadedReport）→ 清手机客户端角标
  // 优先 mark_msg_as_read(message_id) 精确报；再 _mark_all_as_read 清积压
  let lastMarkAt = 0
  async function markQqRead(channel, target, { messageIds, source = 'reply' } = {}) {
    if (source === 'ingest') {
      const now = Date.now()
      if (now - lastMarkAt < 400) return false
      lastMarkAt = now
    }
    const isGroup = channel === 'qq-group'
    const peer = { user_id: Number(target), group_id: Number(target) }
    const fromKernel = (Array.isArray(messageIds) ? messageIds : [])
      .map((id) => String(id ?? ''))
      .filter((id) => /^\d+$/.test(id))
    const last = lastInboundMsgId.get(channel + '/' + target) || ''
    const ids = [...new Set([...fromKernel, last].filter(Boolean))]

    const attempts = []
    if (ids.length) {
      attempts.push({
        action: 'mark_msg_as_read',
        params: ids.length === 1 ? { message_id: Number(ids[0]), ...peer } : { message_ids: ids.map(Number), ...peer },
      })
      attempts.push({
        action: isGroup ? 'mark_group_msg_as_read' : 'mark_private_msg_as_read',
        params: isGroup
          ? { group_id: Number(target), message_id: Number(ids[0]) }
          : { user_id: Number(target), message_id: Number(ids[0]) },
      })
    }
    attempts.push({ action: '_mark_all_as_read', params: {} })

    try {
      for (const { action, params } of attempts) {
        const r = await napcat.callOneBot(action, params)
        const ok = !!(r && (r.status === 'ok' || r.retcode === 0))
        if (ok) {
          diag('已读回执已上报 ' + channel + '/' + target + ' via ' + action + ' ids=' + ids.join(',') + ' src=' + source)
          return true
        }
        diag('已读回执失败 ' + action + ' ' + channel + '/' + target + '：' + JSON.stringify(r).slice(0, 140))
      }
      return false
    } catch (e) {
      diag('已读回执异常：' + (e && e.message))
      return false
    }
  }

  // 出站：内核要发 → 分类器出站审核（关键词快筛 + LLM）→ 发 QQ
  // text 可为纯文本字符串，或 { text?, segments: OneBot 段数组 }（图片/表情）
  async function outbound({ channel, target, text }) {
    const tool = channel === 'qq-group' ? 'send_group_msg' : 'send_private_msg'
    let segments = null
    let plain = ''
    if (text && typeof text === 'object' && Array.isArray(text.segments)) {
      segments = text.segments
      plain = String(text.text || segments.filter((s) => s && s.type === 'text').map((s) => (s.data && s.data.text) || '').join('\n'))
    } else {
      plain = String(text || '')
    }
    // 分类器只审文本部分；纯图/表情且无正文时跳过文本审核
    if (plain.trim()) {
      const verdict = await classifiers.get(tool).check(plain)
      if (!verdict.allow) {
        diag('出站拦截（' + tool + '，' + (verdict.layer || '?') + '）：' + verdict.reason)
        return { ok: false, blocked: true, reason: verdict.reason, category: verdict.category, rewrite: verdict.rewrite }
      }
      if (verdict.needsReview) diag('出站提示（' + tool + '）：' + verdict.reason)
    }
    const message = segments || plain
    const r = channel === 'qq-group'
      ? await napcat.sendGroupMsg(target, message)
      : await napcat.sendPrivateMsg(target, message)
    const okSend = !!(r && (r.status === 'ok' || r.retcode === 0))
    // 回复成功 → 标记 QQ 侧已读（清手机未读角标）
    if (okSend) await markQqRead(channel, target)
    return { ok: okSend, raw: r }
  }

  // 注册到内核
  if (kernel && kernel.onOutbound) {
    kernel.onOutbound('qq-group', outbound)
    kernel.onOutbound('qq-private', outbound)
  }
  // 本地 app_fetch 标已读后 → 同步清 QQ 侧角标
  if (kernel && kernel.onMessagesRead) {
    kernel.onMessagesRead(({ channel, target, msgIds }) => {
      if (channel === 'qq-group' || channel === 'qq-private') {
        Promise.resolve().then(() => markQqRead(channel, target, { messageIds: msgIds })).catch(() => {})
      }
    })
  }

  // 桥接设置路由：/qq-bridge/rules（读写审核规则）
  try {
    const readBody = (req) => new Promise((resolve) => {
      if (req.body !== undefined) return resolve(req.body || {})
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    const ok = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) }
    const fail = (res, e) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e && e.message) })) }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/qq-bridge/rules',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const b = await readBody(req)
            if (b.rules && typeof b.rules === 'object') {
              toolRules = b.rules
              for (const [tool, rules] of Object.entries(toolRules)) classifiers.set(tool, rules)
              try { writeFileSync(join(__dir, 'rules.json'), JSON.stringify(toolRules, null, 2), 'utf8') } catch (e) { /* ignore */ }
            }
            ok(res, { ok: true, rules: toolRules })
          } else ok(res, { ok: true, rules: toolRules })
        } catch (e) { fail(res, e) }
      },
    }))
  } catch (e) { diag('设置路由注册失败：' + (e && e.message)) }

  // QQ 状态（面板用）：登录 + 群 + 推送连接
  // SnowLuma 登录在 WebUI / noVNC 完成；无 NapCat 式 qrcode.png。
  try {
    const readBody = (req) => new Promise((resolve) => {
      if (req.body !== undefined) return resolve(req.body || {})
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    const ok = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) }
    const fail = (res, e) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e && e.message) })) }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/qq-bridge/status',
      handler: async (req, res) => {
        try {
          let container = null
          try {
            const so = await new Promise((resolve, reject) => {
              execFile('docker', ['inspect', 'snowluma', '--format', '{{json .State}}'], { timeout: 4000 }, (e, o) => e ? reject(e) : resolve(String(o).trim()))
            })
            const st = JSON.parse(so)
            container = {
              running: !!st.Running,
              status: st.Status || '',
              startedAt: st.StartedAt || null,
              exitCode: Number.isFinite(st.ExitCode) ? st.ExitCode : null,
            }
          } catch (e) { container = { running: false, status: '容器不存在或 docker 不可用', error: String(e && e.message).slice(0, 120) } }

          const login = await napcat.callOneBot('get_login_info', {})
          const groups = await napcat.callOneBot('get_group_list', {})
          const stOne = await napcat.callOneBot('get_status', {})
          const okLogin = login && (login.status === 'ok' || login.retcode === 0)
          const okGroups = groups && (groups.status === 'ok' || groups.retcode === 0)
          const online = !!(stOne && stOne.data && stOne.data.online)
          const unauthorized = !!(login && (login.retcode === 1401 || /unauthorized/i.test(String(login.wording || login.message || ''))))
          const wsConnected = typeof napcat.wsClientCount === 'function' ? napcat.wsClientCount() > 0 : null

          let phase = 'unknown'
          let phaseLabel = '未知'
          if (!container || !container.running) { phase = 'down'; phaseLabel = '容器未运行' }
          else if (unauthorized) { phase = 'auth'; phaseLabel = 'Token 不匹配' }
          else if (okLogin && wsConnected) { phase = 'online'; phaseLabel = '在线' }
          else if (okLogin) { phase = 'ws_down'; phaseLabel = '已登录但推送未连接' }
          else { phase = 'no_login'; phaseLabel = '未登录' }

          // noVNC / VNC 口令（数据卷明文文件；仅给面板展示，不写日志）
          let vncPassword = ''
          try {
            vncPassword = readFileSync('/mnt/nvme/agent/snowluma/data/config/vnc-password', 'utf8').trim()
          } catch (e) { /* 可能未生成 */ }

          ok(res, {
            ok: true,
            backend: 'snowluma',
            phase, phaseLabel,
            container,
            wsConnected,
            online,
            unauthorized,
            webuiUrl: 'http://192.168.2.192:5099',
            novncUrl: 'http://192.168.2.192:6081',
            vncPassword,
            login: okLogin
              ? { userId: login.data && login.data.user_id, nickname: login.data && login.data.nickname }
              : { error: unauthorized ? 'unauthorized：token 与 snowluma onebot.json 不一致' : JSON.stringify(login).slice(0, 200) },
            groups: okGroups ? (groups.data || []).map((g) => ({ id: g.group_id, name: g.group_name })) : [],
            groupsError: okGroups ? null : JSON.stringify(groups).slice(0, 200),
          })
        } catch (e) { fail(res, e) }
      },
    }))
  } catch (e) { diag('status 路由注册失败：' + (e && e.message)) }

  // 重启 QQ 客户端（面板按钮）
  const restartHandler = async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return }
    try {
      execFile('docker', ['restart', 'snowluma'], { timeout: 30000 }, (e) => {
        if (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '重启失败：' + e.message })); return }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, note: 'QQ 客户端重启中，约 30-60 秒后重连' }))
      })
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
    }
  }
  for (const p of ['/qq-bridge/restart', '/qq-bridge/snowluma/restart']) {
    try {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: p, handler: restartHandler }))
    } catch (e) { diag('restart 路由注册失败 ' + p + '：' + (e && e.message)) }
  }

  // 主动连接 SnowLuma OneBot WS Server（默认 127.0.0.1:3001），接收事件推送
  // 比反向 WS 更稳：不依赖容器能否访问宿主机网关
  let slWsToken = ''
  try {
    const p = '/mnt/nvme/agent/snowluma/data/config/onebot.json'
    const ob = JSON.parse(readFileSync(p, 'utf8'))
    slWsToken = ob?.networks?.wsServers?.[0]?.accessToken || ''
    // per-UIN 覆盖优先
    try {
      const p2 = '/mnt/nvme/agent/snowluma/data/config/onebot_1271693442.json'
      const ob2 = JSON.parse(readFileSync(p2, 'utf8'))
      slWsToken = ob2?.networks?.wsServers?.[0]?.accessToken || slWsToken
    } catch (e2) { /* ignore */ }
  } catch (e) { /* ignore */ }
  napcat.startWsClient({
    url: process.env.SNOWLUMA_ONEBOT_WS || 'ws://127.0.0.1:3001/',
    token: slWsToken,
    onEvent: (ev) => { Promise.resolve().then(() => ingestFromNapcat(ev)).catch((e) => diag('入站处理异常：' + (e && e.message))) },
    reconnectMs: 5000,
  }).then((r) => {
    if (r.ok) diag('已连接 SnowLuma OneBot WS：' + r.url)
    else diag('OneBot WS 连接失败：' + r.error)
  })

  diag('QQ 桥接启动：分类器 ' + Object.keys(toolRules).length + ' 个工具')

  return {
    name,
    napcat, classifiers,
    ingestFromNapcat,
    outbound,
    // 工具：QQ 桥接的设置/状态
  }
}

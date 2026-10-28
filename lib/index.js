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
  const NAPCAT_READ_WHITELIST = new Set([
    'get_login_info', 'get_status', 'get_version_info', 'get_self_info',
    'get_friend_list', 'get_friend_info',
    'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info', 'get_group_honor_info',
    'get_msg', 'get_friend_msg_history', 'get_group_msg_history',
    'get_image', 'get_record', 'get_video',
    // SnowLuma / NapCat 扩展（只读；不支持的 action 调用会失败，不影响其它）
    'get_essence_msg', 'get_essence_msg_list', 'fetch_essence_msg_list',
    'get_group_announce', 'get_group_notice', 'fetch_group_announce',
    'get_group_file_url', 'get_group_root_file', 'get_group_dir_files',
    'get_forward_msg', 'get_group_forward_msg',
    'get_cookies', 'get_csrf_token', 'get_credentials',
    'can_send_image', 'can_send_record', 'get_model_show',
  ])
  const napcatToolDef = {
    name: 'qq_sl_api',
    description: '查 QQ 侧信息（登录状态/好友/群/成员/历史消息等只读接口，OneBot 只读白名单）。发消息不要用这个——你说话自然会发出去。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '接口名，如 get_friend_list / get_group_list / get_msg' },
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
  if (kernel && typeof kernel.mountTool === 'function') {
    // 只挂认领 qq 渠道的角色（character.json.channels）
    const r = kernel.mountTool(napcatToolDef, { channels: ['qq-group', 'qq-private'] })
    diag('qq_sl_api 已交内核按角色挂载' + (r && r.ok === false ? '：' + r.error : ''))
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
  async function ingestFromNapcat(ev) {
    const msg = napcat.normalizeEvent(ev)
    if (!msg) {
      // meta 心跳等：仅留档
      if (ev && ev.post_type && ev.post_type !== 'meta_event') {
        diag('忽略事件：pt=' + ev.post_type + ' nt=' + (ev.notice_type || '') + ' rt=' + (ev.request_type || ''))
      }
      return
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
    diag('入站：' + msg.channel + '/' + msg.target + ' ' + msg.sender + ': ' + String(msg.content).slice(0, 40)
      + (msg.media ? ' media=' + JSON.stringify(msg.media).slice(0, 120) : ''))
    if (!String(msg.content || '').trim()) { diag('空内容消息跳过'); return }
    if (kernel && kernel.ingest) await kernel.ingest(msg)
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
    return { ok: okSend, raw: r }
  }

  // 注册到内核
  if (kernel && kernel.onOutbound) {
    kernel.onOutbound('qq-group', outbound)
    kernel.onOutbound('qq-private', outbound)
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

  // 反向 WS：监听 8643，由 SnowLuma 以 wsClient 连入（与 nc 同构）
  napcat.startWsServer({
    port: Number(process.env.HER_QQ_SL_WS_PORT || 8643),
    onEvent: (ev) => { Promise.resolve().then(() => ingestFromNapcat(ev)).catch((e) => diag('入站处理异常：' + (e && e.message))) },
  }).then((r) => {
    if (r.ok) diag('反向 WS 已监听 ' + r.port + '，等 SnowLuma 连入（配置见 onebot.json wsClients → 宿主机:8643）')
    else diag('反向 WS 启动失败：' + r.error)
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

import { readFileSync, appendFileSync } from 'node:fs'
// dsh-her-qq-bridge-sl · SnowLuma/OneBot 协议适配
//
// 只做协议适配：收推送（WS 事件）、发消息、拉历史。不碰内核逻辑（情绪/记忆/主动在内核）。
// SnowLuma 以 OneBot 推送（事件）+ 拉取（get_group_msg_history/get_friend_msg_history）混合。

// 硬日志（WS 连接状态要可排查）：/tmp/kernel-agent.log
const logWs = (s) => { try { appendFileSync('/tmp/kernel-agent.log', new Date().toISOString() + ' [qq-bridge] ' + s + '\n') } catch (e) { /* ignore */ } }

export function createOnebot({ config, diag = () => {} }) {
  // ⭐ 反向 WS 服务器：SnowLuma 连上来，推送消息事件（取代 qq-companion 的 dsh-onebot 8643）
  let wss = null
  let wsClients = 0 // 当前连入的 OneBot 客户端数（状态面板展示）
  async function startWsServer({ port = 8643, onEvent } = {}) {
    try {
      const { createServer } = await import('node:http')
      const { WebSocketServer } = await import('ws')
      const server = createServer()
      wss = new WebSocketServer({ server })
      wss.on('connection', (ws, req) => {
        const url = new URL(req.url || '/', 'http://x')
        const gotToken = url.searchParams.get('access_token') || url.searchParams.get('token') || ''
        wsClients++
        diag('SnowLuma 反向 WS 已连入：' + req.url + '（当前连接 ' + wsClients + '）')
        logWs('SnowLuma 反向 WS 已连入（当前 ' + wsClients + '）')
        ws.on('message', (data) => {
          try {
            const ev = JSON.parse(String(data))
            if (onEvent) onEvent(ev)
          } catch (e) { diag('WS 消息解析失败：' + (e && e.message)) }
        })
        ws.on('close', () => { wsClients = Math.max(0, wsClients - 1); diag('SnowLuma 反向 WS 断开（剩余 ' + wsClients + '）'); logWs('SnowLuma 反向 WS 断开（剩余 ' + wsClients + '）') })
      })
      // 监听所有接口：容器内 SnowLuma 经 docker0 网关（如 172.17.0.1:8643）连入
      server.listen(port, '0.0.0.0', () => { diag('反向 WS 监听 ws://0.0.0.0:' + port + '（SnowLuma 连宿主机:8643）'); logWs('反向 WS 监听 ' + port) })
      return { ok: true, port }
    } catch (e) {
      diag('反向 WS 启动失败：' + (e && e.message))
      logWs('反向 WS 启动失败：' + e.message)
      return { ok: false, error: String(e && e.message) }
    }
  }
  function stopWsServer() {
    try { if (wss) wss.close() } catch (e) { /* ignore */ }
    wss = null
  }
  function wsClientCount() { return wsClients }

  // 主动连到 SnowLuma OneBot WS（Universal），接收事件推送
  let wsOut = null
  async function startWsClient({ url = 'ws://127.0.0.1:3001/', token = '', onEvent, reconnectMs = 8000 } = {}) {
    try {
      const { WebSocket } = await import('ws')
      const u = new URL(url)
      if (token) u.searchParams.set('access_token', token)
      const connect = () => {
        try {
          wsOut = new WebSocket(u)
        } catch (e) {
          diag('WS 客户端创建失败：' + e.message)
          setTimeout(connect, reconnectMs)
          return
        }
        wsOut.on('open', () => {
          wsClients = 1
          diag('SnowLuma OneBot WS 已连接：' + u.origin)
          logWs('OneBot WS 客户端已连接 ' + u.origin)
        })
        wsOut.on('message', (data) => {
          try {
            const ev = JSON.parse(String(data))
            // 部分实现包一层 { post_type, ... } 或 { action, data }
            const payload = ev && ev.post_type ? ev : (ev && ev.data && ev.data.post_type ? ev.data : ev)
            if (onEvent && payload && payload.post_type) onEvent(payload)
          } catch (e) { diag('WS 消息解析失败：' + e.message) }
        })
        wsOut.on('close', () => {
          wsClients = 0
          diag('SnowLuma OneBot WS 断开，' + Math.round(reconnectMs / 1000) + 's 后重连')
          setTimeout(connect, reconnectMs)
        })
        wsOut.on('error', (e) => {
          diag('SnowLuma OneBot WS 错误：' + e.message)
          try { wsOut.close() } catch (e2) { /* ignore */ }
        })
      }
      connect()
      return { ok: true, url: u.origin }
    } catch (e) {
      diag('WS 客户端启动失败：' + e.message)
      return { ok: false, error: e.message }
    }
  }
  function stopWsClient() {
    try { if (wsOut) wsOut.close() } catch (e) { /* ignore */ }
    wsOut = null
  }
  // 发群消息：text 或段数组（含 image/face）
  async function sendGroupMsg(groupId, message) {
    return callOneBot('send_group_msg', { group_id: Number(groupId), message: toOneBotMessage(message) })
  }
  // 发私聊：text 或段数组（含 image/face）
  async function sendPrivateMsg(userId, message) {
    return callOneBot('send_private_msg', { user_id: Number(userId), message: toOneBotMessage(message) })
  }

  // 文本 / 段数组 → OneBot message 字段
  function toOneBotMessage(message) {
    if (Array.isArray(message)) return message
    if (message && typeof message === 'object' && message.segments) return message.segments
    return String(message ?? '')
  }
  // 拉群历史
  async function getGroupHistory(groupId, { count = 20, messageSeq } = {}) {
    const p = { group_id: Number(groupId), count }
    if (messageSeq) p.message_seq = Number(messageSeq)
    return callOneBot('get_group_msg_history', p)
  }
  // 拉私聊历史
  async function getFriendHistory(userId, { count = 20, messageSeq } = {}) {
    const p = { user_id: Number(userId), count }
    if (messageSeq) p.message_seq = Number(messageSeq)
    return callOneBot('get_friend_msg_history', p)
  }

  // 调 OneBot（经 OneBot HTTP API（SnowLuma），端口 3000）
  async function callOneBot(action, params) {
    const base = config?.onebot?.httpBase || 'http://127.0.0.1:3000'
    let token = config?.onebot?.token || ''
    if (!token) {
      try {
        const ob = JSON.parse(readFileSync('/mnt/nvme/agent/snowluma/data/config/onebot.json', 'utf8'))
        token = ob?.networks?.httpServers?.[0]?.accessToken || ob?.networks?.wsServers?.[0]?.accessToken || ''
      } catch (e) { /* ignore */ }
    }
    if (!token) {
      try { token = readFileSync('/mnt/nvme/agent/dsh/ops/onebot-token.txt', 'utf8').trim() } catch (e) { /* ignore */ }
    }
    diag('callOneBot ' + action + ': token=' + JSON.stringify(token).slice(0, 30) + ' base=' + base)
    try {
      const res = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(params),
      })
      const json = await res.json()
      diag('callOneBot ' + action + ' response: ' + JSON.stringify(json).slice(0, 100))
      return json
    } catch (e) {
      diag('OneBot 调用失败 ' + action + '：' + (e && e.message))
      return { status: 'failed', error: String(e && e.message) }
    }
  }

  // 把 OneBot 推送事件标准化成内核 ingest 格式
  // - message：正常聊天
  // - notice / request：转成合成消息（不改内核），便于入库+通知
  // media：图片/表情/语音/视频结构化引用
  function normalizeEvent(ev) {
    if (!ev || !ev.post_type) return null

    if (ev.post_type === 'notice') return normalizeNotice(ev)
    if (ev.post_type === 'request') return normalizeRequest(ev)
    if (ev.post_type !== 'message') return null

    const isGroup = ev.message_type === 'group'
    const isPrivate = ev.message_type === 'private'
    const raw = ev.message
    const text = typeof raw === 'string' ? extractTextFromCQ(raw) : extractText(raw)
    const media = typeof raw === 'string' ? extractMediaFromCQ(raw) : extractMedia(raw)
    const msg = {
      channel: isGroup ? 'qq-group' : (isPrivate ? 'qq-private' : 'qq-other'),
      target: String(isGroup ? ev.group_id : ev.user_id),
      sender: ev.sender?.card || ev.sender?.nickname || String(ev.user_id || 'system'),
      sender_id: String(ev.user_id || ''),
      content: text,
      time: (ev.time || Date.now() / 1000) * 1000,
      msg_id: String(ev.message_id || ''),
      seq: ev.message_seq || null,
      mention: typeof raw === 'string' ? /CQ:at/.test(raw) : hasMention(raw),
      fromUser: true,
    }
    if (media && (media.images?.length || media.faces?.length || media.records?.length || media.videos?.length)) msg.media = media
    // 撤回：标记原消息（尽力而为）
    if (ev.notice_type === 'group_recall' || ev.notice_type === 'friend_recall') {
      msg.recall = { operator_id: String(ev.operator_id || ''), user_id: String(ev.user_id || '') }
    }
    return msg
  }

  function normalizeNotice(ev) {
    const nt = String(ev.notice_type || '')
    const time = (ev.time || Date.now() / 1000) * 1000
    const base = {
      time,
      fromUser: false,
      msg_id: 'notice-' + (ev.notice_id || nt) + '-' + time,
    }
    // 群管
    if (nt === 'group_increase' || nt === 'group_decrease') {
      return {
        ...base,
        channel: 'qq-group',
        target: String(ev.group_id || ''),
        sender: '系统',
        sender_id: String(ev.user_id || ''),
        content: nt === 'group_increase'
          ? `[系统] ${ev.user_id} 加入群聊${ev.operator_id ? '（操作者 ' + ev.operator_id + '）' : ''}`
          : `[系统] ${ev.user_id} 离开群聊${ev.operator_id ? '（操作者 ' + ev.operator_id + '）' : ''}`,
        notice: { type: nt, group_id: ev.group_id, user_id: ev.user_id, operator_id: ev.operator_id },
        mention: false,
      }
    }
    if (nt === 'group_ban') {
      const dur = Number(ev.duration || 0)
      const lift = !dur || dur === 0
      return {
        ...base,
        channel: 'qq-group',
        target: String(ev.group_id || ''),
        sender: '系统',
        sender_id: String(ev.operator_id || ''),
        content: `[系统] ${lift ? '解除禁言' : '禁言 ' + dur + ' 秒'}：用户 ${ev.user_id}`,
        notice: { type: nt, group_id: ev.group_id, user_id: ev.user_id, duration: dur },
        mention: false,
      }
    }
    if (nt === 'group_admin') {
      return {
        ...base,
        channel: 'qq-group',
        target: String(ev.group_id || ''),
        sender: '系统',
        sender_id: String(ev.user_id || ''),
        content: `[系统] 群管理变更：用户 ${ev.user_id}，sub_type=${ev.sub_type || ''}`,
        notice: { type: nt },
        mention: false,
      }
    }
    // 撤回
    if (nt === 'group_recall' || nt === 'friend_recall') {
      const isG = nt === 'group_recall'
      return {
        ...base,
        channel: isG ? 'qq-group' : 'qq-private',
        target: String(isG ? ev.group_id : ev.user_id),
        sender: '系统',
        sender_id: String(ev.operator_id || ev.user_id || ''),
        content: `[系统] 有消息被撤回（原发送者 ${ev.user_id}，操作者 ${ev.operator_id || ev.user_id}）`,
        notice: { type: nt, message_id: ev.message_id, user_id: ev.user_id },
        mention: false,
      }
    }
    // SnowLuma / NapCat 扩展：群公告变更
    if (nt === 'group_notice' || nt === 'group_announce' || nt === 'notify' && ev.sub_type === 'group_notice') {
      return {
        ...base,
        channel: 'qq-group',
        target: String(ev.group_id || ''),
        sender: '系统',
        sender_id: String(ev.user_id || ''),
        content: '[系统] 群公告有更新',
        notice: { type: nt, sub_type: ev.sub_type },
        mention: false,
      }
    }
    // 纯 notify 心跳/透传（无群/无用户上下文）：丢弃，避免污染消息库
    if (nt === 'notify' || nt === 'message' || nt === 'message_sent') return null
    // 其它 notice：合成短消息，保证可感知
    return {
      ...base,
      channel: 'qq-other',
      target: String(ev.group_id || ev.user_id || 'notice'),
      sender: '系统',
      sender_id: String(ev.user_id || ''),
      content: `[系统通知] ${nt}`,
      notice: { type: nt, raw: true },
      mention: false,
    }
  }

  function normalizeRequest(ev) {
    const rt = String(ev.request_type || '')
    const time = (ev.time || Date.now() / 1000) * 1000
    const isGroup = rt === 'group'
    return {
      channel: isGroup ? 'qq-group' : 'qq-private',
      target: String(isGroup ? ev.group_id : ev.user_id),
      sender: '系统',
      sender_id: String(ev.user_id || ''),
      content: isGroup
        ? `[申请] 入群申请：用户 ${ev.user_id}${ev.comment ? '，留言：' + String(ev.comment).slice(0, 80) : ''}`
        : `[申请] 好友申请：${ev.user_id}${ev.comment ? '，留言：' + String(ev.comment).slice(0, 80) : ''}`,
      time,
      msg_id: 'request-' + (ev.flag || rt) + '-' + time,
      fromUser: false,
      mention: false,
      request: { type: rt, user_id: ev.user_id, group_id: ev.group_id, comment: ev.comment, flag: ev.flag },
    }
  }

  // CQ 码字符串 → 纯文本（保留占位）
  function extractTextFromCQ(str) {
    return String(str)
      .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:marketface[^\]]*\]/g, '[商城表情]')
      .replace(/\[CQ:poke[^\]]*\]/g, '[戳一戳]')
      .replace(/\[CQ:forward[^\]]*\]/g, '[合并转发]')
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      .replace(/\[CQ:at[^\]]*\]/g, '@')
      .replace(/\[CQ:reply[^\]]*\]/g, '[回复]')
      .replace(/\[CQ:[^\]]+\]/g, '[消息]')
      .trim()
  }

  // CQ 码字符串 → media
  function extractMediaFromCQ(str) {
    const images = []
    const faces = []
    const records = []
    const pokes = []
    const marketfaces = []
    let m
    const imgRe = /\[CQ:image,([^\]]*)\]/g
    while ((m = imgRe.exec(str))) {
      const params = {}
      for (const part of m[1].split(',')) {
        const i = part.indexOf('=')
        if (i > 0) params[part.slice(0, i)] = part.slice(i + 1)
      }
      const url = params.url || params.file || ''
      const file = params.file || ''
      if (url || file) {
        images.push({
          url: /^https?:\/\//i.test(url) ? url : '',
          file,
          md5: params.md5 || '',
        })
      }
    }
    const faceRe = /\[CQ:face,id=(\d+)/g
    while ((m = faceRe.exec(str))) faces.push({ id: m[1] })
    const recRe = /\[CQ:record,([^\]]*)\]/g
    while ((m = recRe.exec(str))) {
      const params = {}
      for (const part of m[1].split(',')) {
        const i = part.indexOf('=')
        if (i > 0) params[part.slice(0, i)] = part.slice(i + 1)
      }
      records.push({ url: params.url || '', file: params.file || '', md5: params.md5 || '' })
    }
    const pokeRe = /\[CQ:poke,([^\]]*)\]/g
    while ((m = pokeRe.exec(str))) pokes.push({ type: 'poke', raw: m[1] })
    const mfRe = /\[CQ:marketface,([^\]]*)\]/g
    while ((m = mfRe.exec(str))) {
      const params = {}
      for (const part of m[1].split(',')) {
        const i = part.indexOf('=')
        if (i > 0) params[part.slice(0, i)] = part.slice(i + 1)
      }
      marketfaces.push({ id: params.face_id || params.id || '', name: params.faceName || '', url: params.url || '' })
    }
    const out = {}
    if (images.length) out.images = images
    if (faces.length) out.faces = faces
    if (records.length) out.records = records
    if (pokes.length) out.pokes = pokes
    if (marketfaces.length) out.marketfaces = marketfaces
    return Object.keys(out).length ? out : null
  }

  // 提取图片 / 表情 / 语音 / 视频 / 商城表情 / 戳一戳
  function extractMedia(message) {
    if (!Array.isArray(message)) return null
    const images = []
    const faces = []
    const records = []
    const videos = []
    const pokes = []
    const marketfaces = []
    for (const seg of message) {
      if (!seg || !seg.type) continue
      const d = seg.data || {}
      if (seg.type === 'image') {
        const url = String(d.url || d.file || '').trim()
        if (url) images.push({ url: url.startsWith('http') ? url : '', file: String(d.file || ''), md5: String(d.md5 || '') })
      } else if (seg.type === 'face') {
        if (d.id != null && String(d.id) !== '') faces.push({ id: String(d.id), name: d.name ? String(d.name) : undefined })
      } else if (seg.type === 'marketface') {
        marketfaces.push({ id: String(d.face_id || d.id || ''), name: d.faceName ? String(d.faceName) : undefined, url: d.url ? String(d.url) : '' })
      } else if (seg.type === 'record') {
        records.push({ url: d.url ? String(d.url) : '', file: d.file ? String(d.file) : '', md5: d.md5 ? String(d.md5) : '' })
      } else if (seg.type === 'video') {
        videos.push({ url: d.url ? String(d.url) : '', file: d.file ? String(d.file) : '' })
      } else if (seg.type === 'poke') {
        pokes.push({ type: d.type != null ? String(d.type) : 'poke' })
      }
    }
    const out = {}
    if (images.length) out.images = images
    if (faces.length) out.faces = faces
    if (records.length) out.records = records
    if (videos.length) out.videos = videos
    if (pokes.length) out.pokes = pokes
    if (marketfaces.length) out.marketfaces = marketfaces
    return Object.keys(out).length ? out : null
  }

  // 消息段 → 纯文本：文字原样，非文本段给占位符
  function extractText(message) {
    if (typeof message === 'string') return message
    if (Array.isArray(message)) {
      return message.map((seg) => {
        if (!seg || !seg.type) return ''
        if (seg.type === 'text') return seg.data?.text || ''
        if (seg.type === 'at') return '@' + (seg.data?.qq || seg.data?.name || '')
        if (seg.type === 'face') return '[表情' + (seg.data?.id != null ? ':' + seg.data.id : '') + ']'
        if (seg.type === 'image') return '[图片]'
        if (seg.type === 'marketface') return '[商城表情' + (seg.data?.faceName ? ':' + seg.data.faceName : '') + ']'
        if (seg.type === 'record') return '[语音]'
        if (seg.type === 'video') return '[视频]'
        if (seg.type === 'reply') return '[回复]'
        if (seg.type === 'poke') return '[戳一戳]'
        if (seg.type === 'forward' || seg.type === 'node') return '[合并转发]'
        if (seg.type === 'json' || seg.type === 'xml') return '[卡片消息]'
        if (seg.type === 'file') return '[文件' + (seg.data?.file_name ? ':' + seg.data.file_name : '') + ']'
        return '[' + seg.type + ']'
      }).join('').trim()
    }
    return ''
  }
  function hasMention(message) {
    return Array.isArray(message) && message.some((seg) => seg.type === 'at')
  }

  return { sendGroupMsg, sendPrivateMsg, getGroupHistory, getFriendHistory, callOneBot, normalizeEvent, extractMedia, startWsServer, stopWsServer, startWsClient, stopWsClient, wsClientCount }
}

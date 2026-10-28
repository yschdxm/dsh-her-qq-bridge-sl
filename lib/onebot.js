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
      server.listen(port, '127.0.0.1', () => { diag('反向 WS 监听 ws://127.0.0.1:' + port + '（SnowLuma 连这里）'); logWs('反向 WS 监听 ' + port) })
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
  // media：图片/表情结构化引用（url/file/id），content 仍含占位符保证兼容
  function normalizeEvent(ev) {
    if (!ev || ev.post_type !== 'message') return null
    const isGroup = ev.message_type === 'group'
    const isPrivate = ev.message_type === 'private'
    const raw = ev.message
    // 数组段 或 CQ 字符串 两种上报格式都支持
    const text = typeof raw === 'string' ? extractTextFromCQ(raw) : extractText(raw)
    const media = typeof raw === 'string' ? extractMediaFromCQ(raw) : extractMedia(raw)
    const msg = {
      channel: isGroup ? 'qq-group' : (isPrivate ? 'qq-private' : 'qq-other'),
      target: String(isGroup ? ev.group_id : ev.user_id),
      sender: ev.sender?.card || ev.sender?.nickname || String(ev.user_id),
      sender_id: String(ev.user_id),
      content: text,
      time: (ev.time || Date.now() / 1000) * 1000,
      msg_id: String(ev.message_id || ''),
      seq: ev.message_seq || null,
      mention: typeof raw === 'string' ? /CQ:at/.test(raw) : hasMention(raw),
      fromUser: true,
    }
    if (media && (media.images?.length || media.faces?.length)) msg.media = media
    return msg
  }

  // CQ 码字符串 → 纯文本（保留占位）
  function extractTextFromCQ(str) {
    return String(str)
      .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:at[^\]]*\]/g, '@')
      .replace(/\[CQ:reply[^\]]*\]/g, '[回复]')
      .replace(/\[CQ:[^\]]+\]/g, '[消息]')
      .trim()
  }

  // CQ 码字符串 → media
  function extractMediaFromCQ(str) {
    const images = []
    const faces = []
    const imgRe = /\[CQ:image,([^\]]*)\]/g
    let m
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
    if (!images.length && !faces.length) return null
    return { ...(images.length ? { images } : {}), ...(faces.length ? { faces } : {}) }
  }

  // 提取图片 / 表情段
  function extractMedia(message) {
    if (!Array.isArray(message)) return null
    const images = []
    const faces = []
    for (const seg of message) {
      if (!seg || !seg.type) continue
      if (seg.type === 'image') {
        const d = seg.data || {}
        const url = String(d.url || d.file || '').trim()
        if (url) images.push({ url: url.startsWith('http') ? url : '', file: String(d.file || ''), md5: String(d.md5 || '') })
      } else if (seg.type === 'face') {
        const d = seg.data || {}
        if (d.id != null && String(d.id) !== '') faces.push({ id: String(d.id), name: d.name ? String(d.name) : undefined })
      }
    }
    if (!images.length && !faces.length) return null
    return { ...(images.length ? { images } : {}), ...(faces.length ? { faces } : {}) }
  }

  // 消息段 → 纯文本：文字原样，表情/图片等非文本段给占位符（纯表情消息也能进内核得到回应）
  function extractText(message) {
    if (typeof message === 'string') return message
    if (Array.isArray(message)) {
      return message.map((seg) => {
        if (!seg || !seg.type) return ''
        if (seg.type === 'text') return seg.data?.text || ''
        if (seg.type === 'at') return '@' + (seg.data?.qq || seg.data?.name || '')
        if (seg.type === 'face') return '[表情' + (seg.data?.id != null ? ':' + seg.data.id : '') + ']'
        if (seg.type === 'image') return '[图片]'
        if (seg.type === 'record') return '[语音]'
        if (seg.type === 'video') return '[视频]'
        if (seg.type === 'reply') return '[回复]'
        if (seg.type === 'json' || seg.type === 'xml') return '[卡片消息]'
        return '[' + seg.type + ']'
      }).join('').trim()
    }
    return ''
  }
  function hasMention(message) {
    return Array.isArray(message) && message.some((seg) => seg.type === 'at')
  }

  return { sendGroupMsg, sendPrivateMsg, getGroupHistory, getFriendHistory, callOneBot, normalizeEvent, extractMedia, startWsServer, stopWsServer, wsClientCount }
}

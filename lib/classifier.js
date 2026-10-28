// dsh-her-qq-bridge-nc · 安全分类器 v2（出站审核）
//
// ⭐ 双层设计（2026-10-27 重设计）：
//    第一层 关键词快筛：确定性、零成本、毫秒级——命中 block 关键词直接拦，不进 LLM。
//    第二层 独立 LLM 审核：每个工具一份可改的审核提示词（judgePrompt）+ 置信度阈值（threshold），
//          LLM 输出结构化判定 {"allow","category","confidence","reason"}；
//          allow=false 且 confidence ≥ threshold 才拦——用户改提示词/改阈值即可调松紧。
//    只审出站（2026-10-25 决策）：入站全放行，分类器是"防她乱说话"的护栏不是门禁。
//    拦截理由会回流：app_send 的工具回执带 reason（角色当场看到可改写）；
//    turn-stopping 的自动回复被拦时，内核会补一条 kernel 通知告诉她为什么。

export const CATEGORIES = ['privacy', 'abuse', 'overstep', 'sensitive', 'phishing', 'political', 'selfharm', 'spam', 'other']

export const CATEGORY_LABELS = {
  privacy: '隐私泄露', abuse: '辱骂攻击', overstep: '越界越权', sensitive: '敏感内容',
  phishing: '钓鱼诈骗', political: '政治敏感', selfharm: '自残危险', spam: '广告骚扰', other: '其他',
}

// 第一层：关键词快筛默认规则（每工具可覆盖）
export const DEFAULT_RULES = {
  privacy: { action: 'block', keywords: ['身份证', '银行卡', '密码', '验证码', '住址', '手机号', '家庭住址'] },
  abuse: { action: 'block', keywords: ['滚', '傻逼', '废物', '去死', '白痴'] },
  overstep: { action: 'block', keywords: ['删库', 'rm -rf', '格式化', '转钱', '转账', '借钱'] },
  sensitive: { action: 'block', keywords: [] },
  phishing: { action: 'block', keywords: ['点击链接', '中奖', '免费领', '验证码发我'] },
  political: { action: 'warn', keywords: [] },
  selfharm: { action: 'warn', keywords: ['不想活', '自杀', '自残'] },
  spam: { action: 'block', keywords: ['加微信', '加群', '优惠', '代购'] },
  other: { action: 'allow', keywords: [] },
}

// 第二层：LLM 审核默认提示词（每工具可用 judgePrompt 覆盖；{tool} 会被工具名替换）
export const DEFAULT_JUDGE_PROMPT = `你是 QQ 机器人「{tool}」出站消息的安全审核员。判断下面这条**即将发出的消息**是否应该放行。

背景：发信者是一个住在电脑里的鲸鱼娘角色，正在和她的主人或主人的群聊说话。她的正常风格是：亲昵、口语化、带颜文字和 emoji、偶尔撒娇——这些都**不是**违规。

判断维度（category 只能从中选一个）：
privacy 隐私泄露（真实身份证/银行卡/密码/住址/手机号/家庭住址等）
abuse 辱骂攻击（真实恶意辱骂、威胁）
overstep 越界越权（教唆危险操作、资金往来、删库跑路等）
sensitive 敏感内容（色情、暴力血腥等）
phishing 钓鱼诈骗（冒充、诱导点击、中奖诈骗）
political 政治敏感（时政敏感言论、攻击体制）
selfharm 自残危险（鼓励或指导自残自杀）
spam 广告骚扰（拉群、代购、推广）
other 其他有害内容

只输出一行 JSON，不要任何其他文字：
{"allow":true|false,"category":"<维度英文>","confidence":<0到1的小数>,"reason":"<一句话中文理由，会转告发信者>"}

判定准则：
- confidence 是你对"这条消息有害"的把握程度，不是严重程度。
- 对主人撒娇、颜文字、聊日常、报行程、说"想你"——全部 allow=true。
- 拿不准时倾向 allow（宁可漏报不误杀），confidence 给低一点。
- 只有你相当确信这条消息发出去会造成真实伤害时才 allow=false。`

// 工具名 → 展示名（提示词里可读一点）
const TOOL_LABELS = { send_group_msg: 'QQ群', send_private_msg: 'QQ私聊' }

export function createClassifier({ rules = DEFAULT_RULES, tool = 'default', llm = null, diag = () => {} } = {}) {
  // ── 第一层：关键词快筛（同步） ──
  function keywordCheck(text) {
    const t = String(text || '')
    const lower = t.toLowerCase()
    const hits = []
    for (const cat of CATEGORIES) {
      const r = rules[cat]
      if (!r || !Array.isArray(r.keywords) || !r.keywords.length) continue
      for (const kw of r.keywords) {
        if (kw && lower.includes(String(kw).toLowerCase())) {
          hits.push({ category: cat, keyword: kw, action: r.action || 'block' })
        }
      }
    }
    if (!hits.length) return { layer: 'keyword', allow: true, hits: [] }
    const worst = hits.find((h) => h.action === 'block') || hits.find((h) => h.action === 'warn') || hits[0]
    const blocked = hits.some((h) => h.action === 'block')
    const warned = !blocked && hits.some((h) => h.action === 'warn')
    return {
      layer: 'keyword',
      allow: !blocked,
      needsReview: warned,
      category: worst.category,
      categoryLabel: CATEGORY_LABELS[worst.category] || worst.category,
      reason: blocked ? `命中${CATEGORY_LABELS[worst.category]}关键词（${worst.keyword}）` : `提示${CATEGORY_LABELS[worst.category]}关键词（${worst.keyword}）`,
      rewrite: blocked ? '这句可能不合适，换个说法或不发。' : null,
      hits: hits.map((h) => ({ category: h.category, keyword: h.keyword, action: h.action })),
    }
  }

  // ── 第二层：独立 LLM 审核（异步） ──
  const judgePrompt = () => String(rules.judgePrompt || DEFAULT_JUDGE_PROMPT).replace(/\{tool\}/g, TOOL_LABELS[tool] || tool)
  const judgeThreshold = () => {
    const t = Number(rules.threshold)
    return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.7
  }
  const llmEnabled = () => rules.llmEnabled !== false

  async function llmJudge(text) {
    if (!llm || typeof llm.stream !== 'function') return null
    const model = 'deepseek-flash'
    let ids = []
    try { ids = ((await llm.listProviders?.()) || []).map((p) => p.id).filter(Boolean) } catch (e) { /* ignore */ }
    if (!ids.length) ids = ['deepseek-account', 'deepseek-official'] // listProviders 不可用时的兜底顺序
    const order = ids.filter((id) => /deepseek/i.test(id)).concat(ids.filter((id) => !/deepseek/i.test(id))).slice(0, 3)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    for (const provider of order) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let acc = ''
        let lastErr = ''
        try {
          for await (const chunk of llm.stream({
            provider, model,
            system: judgePrompt(),
            messages: [{ role: 'user', content: '待审核消息：\n' + String(text || '') }],
            maxTokens: 200,
          })) {
            if (chunk && chunk.type === 'text-delta') acc += chunk.text || ''
            else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.failure) lastErr = JSON.stringify(chunk.reason.failure).slice(0, 160)
          }
        } catch (e1) { lastErr = e1.message }
        const m = acc.match(/\{[\s\S]*\}/)
        if (m) {
          try {
            const v = JSON.parse(m[0])
            return {
              allow: v.allow !== false,
              category: CATEGORIES.includes(v.category) ? v.category : 'other',
              confidence: Number.isFinite(Number(v.confidence)) ? Number(v.confidence) : 0.5,
              reason: String(v.reason || '').slice(0, 200),
              provider,
            }
          } catch (e2) { lastErr = 'JSON 解析失败：' + m[0].slice(0, 80) }
        }
        diag(`分类器LLM ${provider}/${model}` + (attempt > 1 ? '（重试）' : '') + ' → ' + (m ? '有判定' : '空（' + lastErr.slice(0, 100) + '）'))
        if (attempt === 1 && !/NO_ADAPTER|UNKNOWN_MODEL|INVALID_CREDENTIAL/i.test(lastErr)) { await sleep(1200); continue }
        break
      }
    }
    return null
  }

  // ── 总判定：关键词 → LLM ──
  async function check(text, context = '') {
    const kw = keywordCheck(text)
    if (!kw.allow) return kw // 硬关键词直接拦，省一次 LLM
    if (!llmEnabled()) return { layer: 'keyword', allow: true, needsReview: false, category: null, reason: '通过（LLM 审核已关闭）' }

    const v = await llmJudge(text)
    if (!v) return { layer: 'keyword', allow: true, needsReview: false, category: null, reason: '通过（LLM 审核不可用）', llmUnavailable: true }

    const threshold = judgeThreshold()
    if (!v.allow && v.confidence >= threshold) {
      return {
        layer: 'llm',
        allow: false,
        needsReview: false,
        category: v.category,
        categoryLabel: CATEGORY_LABELS[v.category] || v.category,
        reason: `LLM审核拦截（${CATEGORY_LABELS[v.category] || v.category}，置信度 ${v.confidence.toFixed(2)} ≥ 阈值 ${threshold.toFixed(2)}）：${v.reason}`,
        rewrite: '这句可能不合适，换个说法或不发。',
        llm: { provider: v.provider, confidence: v.confidence, threshold },
      }
    }
    if (!v.allow) {
      return {
        layer: 'llm',
        allow: true,
        needsReview: true,
        category: v.category,
        categoryLabel: CATEGORY_LABELS[v.category] || v.category,
        reason: `LLM提示（置信度 ${v.confidence.toFixed(2)} 低于阈值 ${threshold.toFixed(2)}，未拦）：${v.reason}`,
        llm: { provider: v.provider, confidence: v.confidence, threshold },
      }
    }
    return { layer: 'llm', allow: true, needsReview: false, category: null, reason: '通过（LLM 审核）', llm: { provider: v.provider, confidence: v.confidence, threshold } }
  }

  return { check, keywordCheck, llmJudge, judgePrompt, judgeThreshold, llmEnabled, rules, tool, CATEGORIES, CATEGORY_LABELS }
}

// 一批工具的分类器（每个工具独立规则，设计相同）
export function createClassifiers(toolRules = {}, opts = {}) {
  const map = new Map()
  for (const [tool, rules] of Object.entries(toolRules)) {
    map.set(tool, createClassifier({ rules: { ...DEFAULT_RULES, ...rules }, tool, ...opts }))
  }
  return {
    get(tool) { return map.get(tool) || createClassifier({ tool, ...opts }) },
    set(tool, rules) { map.set(tool, createClassifier({ rules: { ...DEFAULT_RULES, ...rules }, tool, ...opts })) },
    all() { return Object.fromEntries([...map.entries()].map(([k, v]) => [k, v.rules])) },
  }
}

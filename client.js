// dsh-her-qq-bridge-sl —— 角色 → QQ 页签（连接 / 群白名单 / 渠道规则 / 出站分类器）
// 由桥接注册；内核仅渲染 tab 列表并传入 props，不感知 QQ/SnowLuma 细节。
window.__ModuleLoader__.load({
  id: 'dsh-her-qq-bridge-sl',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const CSS = `
[data-qqsl]{font-family:inherit;color:inherit;line-height:1.6;}
[data-qqsl-card]{border:1px solid rgba(127,127,127,.18);border-radius:12px;padding:14px;margin-bottom:12px;}
[data-qqsl-title]{font-size:14px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
[data-qqsl-title]:before{content:"";width:4px;height:14px;border-radius:2px;background:rgba(90,140,255,.7);}
[data-qqsl-chip]{display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;font-size:11px;background:rgba(127,127,127,.14);margin:0 6px 6px 0;}
[data-qqsl-row]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
[data-qqsl-tip]{font-size:11.5px;opacity:.55;margin:4px 0 8px;line-height:1.5;}
[data-qqsl-btn]{padding:6px 12px;border-radius:8px;border:none;background:rgba(90,140,255,.22);color:inherit;font-size:12.5px;cursor:pointer;}
[data-qqsl-btn]:hover{background:rgba(90,140,255,.35);}
[data-qqsl-btn-sm]{padding:4px 10px;font-size:12px;}
[data-qqsl-note]{font-size:12.5px;opacity:.65;margin:4px 0;}
[data-qqsl-input]{flex:1;min-width:100px;padding:6px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font-size:13px;}
[data-qqsl-chk]{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;margin:0 10px 6px 0;cursor:pointer;}
[data-qqsl-label]{font-size:12px;font-weight:600;}
[data-qqsl-cat]{border:1px solid rgba(127,127,127,.14);border-radius:8px;padding:8px 10px;margin-bottom:8px;}
[data-qqsl-cat-head]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px;}
`
    const CATS = ['privacy', 'abuse', 'overstep', 'sensitive', 'phishing', 'political', 'selfharm', 'spam', 'other']
    const CAT_LABELS = { privacy: '隐私', abuse: '辱骂', overstep: '越界', sensitive: '敏感', phishing: '钓鱼', political: '政治', selfharm: '自伤', spam: '广告', other: '其他' }
    const CAT_DEFAULT = { political: 'warn', selfharm: 'warn', other: 'allow' }

    const readErr = async (r) => { try { const j = await r.json(); if (j && j.error) return j.error } catch (e) { /* ignore */ } return 'HTTP ' + r.status }
    const getJson = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(await readErr(r)); return r.json() }
    const postJson = async (u, b) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(await readErr(r)); return r.json() }
    const clone = (o) => JSON.parse(JSON.stringify(o))

    // 注册进内核角色面板的动态页签
    const reg = (typeof window !== 'undefined' ? (window.__HER_CHANNEL_TABS__ = window.__HER_CHANNEL_TABS__ || []) : [])

    function QqPanel(props) {
      const ws = (props && props.ws) || ''
      const groups = (props && props.groups) || []
      const setGroups = (props && props.setGroups) || (() => {})
      const saveChar = (props && props.saveChar) || (async () => {})
      const cfg = (props && props.cfg) || {}
      const setCfg = (props && props.setCfg) || (() => {})
      const setMsg = (props && props.setMsg) || (() => {})
      const [st, setSt] = React.useState(null)
      const [msg, setLocalMsg] = React.useState('')
      const [rules, setRules] = React.useState(null)
      const backend = (st && st.backend) || 'qq'
      const label = backend === 'snowluma' ? 'SnowLuma' : backend === 'napcat' ? 'NapCat' : 'QQ 客户端'
      const note = (m) => { setLocalMsg(m); try { setMsg(m) } catch (e) { /* ignore */ } }

      React.useEffect(() => {
        getJson('/qq-bridge/status').then(setSt).catch((e) => setSt({ error: e.message }))
        getJson('/qq-bridge/rules').then((r) => setRules(r.rules || {})).catch(() => setRules({}))
      }, [])
      React.useEffect(() => {
        if (!st || st.wsConnected) return
        const t = setInterval(() => {
          getJson('/qq-bridge/status').then(setSt).catch(() => {})
        }, 8000)
        return () => clearInterval(t)
      }, [st && st.wsConnected])

      const saveRules = async () => {
        try { await postJson('/qq-bridge/rules', { rules }); note('✅ 审核规则已保存') } catch (e) { note('❌ ' + e.message) }
      }
      const saveGroups = async () => {
        try { await saveChar(); note('✅ 群白名单已保存') } catch (e) { note('❌ ' + e.message) }
      }
      const ch = (cfg && cfg.channels) || {}
      const setCh = (type, path, val) => {
        if (!setCfg) return
        setCfg((cc) => {
          if (!cc) return cc
          const nn = clone(cc)
          nn.channels = nn.channels || {}
          nn.channels[type] = nn.channels[type] || {}
          if (path.includes('.')) {
            const [k1, k2] = path.split('.')
            nn.channels[type][k1] = nn.channels[type][k1] || {}
            nn.channels[type][k1][k2] = val
          } else nn.channels[type][path] = val
          return nn
        })
      }
      const saveChannel = async (type) => {
        try { await postJson('/her-kernel/config', { patch: { channels: { [type]: ch[type] } } }); note('✅ 渠道规则已保存（热生效）') } catch (e) { note('❌ ' + e.message) }
      }

      const phaseColor = st && st.phase === 'online' && st.wsConnected
        ? { background: 'rgba(76,175,80,.18)', color: '#4caf50' }
        : st && st.phase === 'down'
          ? { background: 'rgba(239,83,80,.18)', color: '#ef5350' }
          : { background: 'rgba(255,171,64,.16)', color: '#ffb300' }

      return h('div', { 'data-qqsl': '' },
        // ── 连接 ──
        h('div', { 'data-qqsl-card': '' },
          h('div', { 'data-qqsl-title': '' }, '连接状态'),
          !st ? h('div', { 'data-qqsl-note': '' }, '加载中…')
            : st.error ? h('div', { 'data-qqsl-note': '' }, '⚠ ' + st.error)
            : h('div', null,
              h('div', { 'data-qqsl-row': '' },
                h('span', { 'data-qqsl-chip': '', style: phaseColor },
                  label + '：' + (st.phaseLabel || (st.wsConnected ? '在线' : '未连接'))),
                st.container
                  ? h('span', { 'data-qqsl-tip': '', style: { margin: 0 } },
                      st.container.running ? '容器运行中' : ('容器' + (st.container.status || '未运行')))
                  : null,
                st.login && st.login.nickname
                  ? h('span', { 'data-qqsl-chip': '' }, '登录：' + st.login.nickname + '（' + st.login.userId + '）')
                  : h('span', { 'data-qqsl-tip': '', style: { margin: 0 } }, '未登录'),
                st.wsConnected
                  ? h('span', { 'data-qqsl-chip': '', style: { background: 'rgba(76,175,80,.18)', color: '#4caf50' } }, '推送已连接')
                  : h('span', { 'data-qqsl-chip': '', style: { background: 'rgba(239,83,80,.18)', color: '#ef5350' } }, '⚠ 推送未连接'),
              ),
              h('div', { 'data-qqsl-tip': '' },
                'SnowLuma 登录在 WebUI / 远程桌面完成，不使用 NapCat 二维码接口。'),
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '6px 0 10px' } },
                h('a', {
                  href: (st && st.webuiUrl) || 'http://192.168.2.192:5099',
                  target: '_blank', rel: 'noreferrer',
                  'data-qqsl-btn': 'data-qqsl-btn-sm',
                  style: { textDecoration: 'none', display: 'inline-block' },
                }, '打开 WebUI'),
                h('a', {
                  href: (st && st.novncUrl) || 'http://192.168.2.192:6081',
                  target: '_blank', rel: 'noreferrer',
                  'data-qqsl-btn': 'data-qqsl-btn-sm',
                  style: { textDecoration: 'none', display: 'inline-block' },
                }, '打开远程桌面（扫码用）'),
              ),
              h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                  'data-qqsl-btn': 'data-qqsl-btn-sm',
                  onClick: async () => {
                    note('⏳ 重启 QQ 客户端…')
                    try {
                      const r = await postJson('/qq-bridge/restart', {})
                      note(r.note ? '✅ ' + r.note : '✅ 已重启')
                    } catch (e) { note('❌ 重启失败：' + e.message) }
                  },
                }, '🔁 重启客户端'),
                h('button', {
                  'data-qqsl-btn': 'data-qqsl-btn-sm',
                  onClick: () => { getJson('/qq-bridge/status').then(setSt).catch((e) => setSt({ error: e.message })); note('已刷新状态') },
                }, '刷新状态'),
              ),
            ),
        ),
        msg || (st && st.error) ? null : null,
        // ── 群白名单 ──
        h('div', { 'data-qqsl-card': '' },
          h('div', { 'data-qqsl-title': '' }, '允许的群聊'),
          h('p', { 'data-qqsl-tip': '' }, '仅接收名单内群消息；私聊不受影响。留空 = 不限制。点群名加入/移出。'),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' } },
            (st && st.groups || []).slice(0, 30).map((g) => h('button', {
              key: g.id,
              'data-qqsl-btn': 'data-qqsl-btn-sm' + (groups.includes(String(g.id)) ? '' : ''),
              style: groups.includes(String(g.id)) ? { background: 'rgba(76,175,80,.25)' } : {},
              title: String(g.id),
              onClick: () => setGroups(groups.includes(String(g.id)) ? groups.filter((x) => x !== String(g.id)) : [...groups, String(g.id)]),
            }, (groups.includes(String(g.id)) ? '✓ ' : '＋ ') + (g.name || g.id))),
          ),
          h('button', { 'data-qqsl-btn': 'data-qqsl-btn-sm', onClick: saveGroups }, '保存群白名单'),
        ),
        // ── 渠道规则 ──
        h('div', { 'data-qqsl-card': '' },
          h('div', { 'data-qqsl-title': '' }, '渠道规则'),
          ['qq-group', 'qq-private'].map((type) => {
            const c = ch[type] || {}
            const n = c.notify || {}
            const a = c.app || {}
            return h('div', { key: type, style: { border: '1px solid rgba(127,127,127,.14)', borderRadius: '8px', padding: '10px', marginBottom: '10px' } },
              h('div', { style: { fontWeight: 600, marginBottom: '6px', fontSize: '13px' } }, type),
              h('label', { 'data-qqsl-label': '' }, '通知格式'),
              h('input', {
                'data-qqsl-input': '', style: { width: '100%', marginBottom: '6px' },
                value: n.format || '', onChange: (e) => setCh(type, 'notify.format', e.target.value),
              }),
              h('div', { 'data-qqsl-row': '' },
                h('label', { 'data-qqsl-chk': '' }, h('input', { type: 'checkbox', checked: !!n.atOnly, onChange: (e) => setCh(type, 'notify.atOnly', e.target.checked) }), ' 仅 @她'),
                h('label', { 'data-qqsl-chk': '' }, h('input', { type: 'checkbox', checked: !!n.dmPriority, onChange: (e) => setCh(type, 'notify.dmPriority', e.target.checked) }), ' 私聊优先'),
                h('label', { 'data-qqsl-chk': '' }, h('input', { type: 'checkbox', checked: n.injectEnabled !== false, onChange: (e) => setCh(type, 'notify.injectEnabled', e.target.checked) }), ' 允许注入'),
                h('label', { 'data-qqsl-chk': '' }, h('input', { type: 'checkbox', checked: n.injectRespectQuiet !== false, onChange: (e) => setCh(type, 'notify.injectRespectQuiet', e.target.checked) }), ' 夜间静默'),
              ),
              h('div', { 'data-qqsl-row': '', style: { gap: '10px' } },
                h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, '静默',
                  h('input', { 'data-qqsl-input': '', style: { maxWidth: '52px', minWidth: '40px' }, type: 'number', value: Number(n.silentMinutes || 0), onChange: (e) => setCh(type, 'notify.silentMinutes', Number(e.target.value)) })),
                h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, '一页',
                  h('input', { 'data-qqsl-input': '', style: { maxWidth: '52px', minWidth: '40px' }, type: 'number', value: Number(a.pageSize || 10), onChange: (e) => setCh(type, 'app.pageSize', Number(e.target.value)) })),
                h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, '冷却分',
                  h('input', { 'data-qqsl-input': '', style: { maxWidth: '52px', minWidth: '40px' }, type: 'number', value: Number(n.injectCooldownMinutes != null ? n.injectCooldownMinutes : 10), onChange: (e) => setCh(type, 'notify.injectCooldownMinutes', Number(e.target.value)) })),
                h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, '日上限',
                  h('input', { 'data-qqsl-input': '', style: { maxWidth: '52px', minWidth: '40px' }, type: 'number', value: Number(n.injectDailyCap != null ? n.injectDailyCap : 8), onChange: (e) => setCh(type, 'notify.injectDailyCap', Number(e.target.value)) })),
              ),
              h('div', { 'data-qqsl-tip': '' }, '注入参数仅作用于本渠道。冷却/上限 0=不限；输出中自动挂起，空闲后再注入。'),
              h('button', { 'data-qqsl-btn': 'data-qqsl-btn-sm', onClick: () => saveChannel(type) }, '保存 ' + type),
            )
          }),
        ),
        // ── 出站分类器 ──
        h('div', { 'data-qqsl-card': '' },
          h('div', { 'data-qqsl-title': '' }, '出站分类器（关键词 + LLM）'),
          h('div', { 'data-qqsl-tip': '' }, '只审她发出的内容；入站不拦。拦截理由会回流给她。'),
          !rules ? h('div', { 'data-qqsl-note': '' }, '加载中…')
            : Object.entries(rules).map(([tool, r]) => h('div', { key: tool, style: { marginBottom: '12px' } },
              h('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '4px' } }, tool),
              h('div', { 'data-qqsl-row': '' },
                h('label', { 'data-qqsl-chk': '' },
                  h('input', { type: 'checkbox', checked: r.llmEnabled !== false, onChange: (e) => setRules((rs) => { const nn = clone(rs); nn[tool] = nn[tool] || {}; nn[tool].llmEnabled = e.target.checked; return nn }) }),
                  ' LLM'),
                h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, '阈值',
                  h('input', { 'data-qqsl-input': '', style: { maxWidth: '56px', minWidth: '40px' }, type: 'number', step: '0.05', min: 0, max: 1, value: Number(r.threshold != null ? r.threshold : 0.7), onChange: (e) => setRules((rs) => { const nn = clone(rs); nn[tool] = nn[tool] || {}; nn[tool].threshold = Number(e.target.value); return nn }) })),
              ),
              h('textarea', {
                'data-qqsl-input': '',
                style: { width: '100%', minHeight: '80px', fontSize: '12px', marginTop: '6px' },
                placeholder: '审核提示词（留空用默认）',
                value: r.judgePrompt || '',
                onChange: (e) => setRules((rs) => { const nn = clone(rs); nn[tool] = nn[tool] || {}; nn[tool].judgePrompt = e.target.value; return nn }),
              }),
              CATS.map((cat) => {
                const c = (r && r[cat]) || {}
                const setRule = (k, v) => setRules((rs) => { const nn = clone(rs); nn[tool] = nn[tool] || {}; nn[tool][cat] = { ...(nn[tool][cat] || {}), [k]: v }; return nn })
                return h('div', { 'data-qqsl-cat': '', key: cat },
                  h('div', { 'data-qqsl-cat-head': '' },
                    h('span', { style: { minWidth: '48px', fontSize: '12px' } }, CAT_LABELS[cat]),
                    h('select', {
                      'data-qqsl-input': '', style: { maxWidth: '90px', flex: 'none' },
                      value: c.action || CAT_DEFAULT[cat] || 'block',
                      onChange: (e) => setRule('action', e.target.value),
                    }, ['block', 'warn', 'allow'].map((o) => h('option', { key: o, value: o }, { block: '拦', warn: '提示', allow: '放' }[o]))),
                  ),
                  h('textarea', {
                    'data-qqsl-input': '',
                    style: { width: '100%', minHeight: '36px', fontSize: '12px' },
                    placeholder: '关键词，逗号分隔',
                    value: (c.keywords || []).join(','),
                    onChange: (e) => setRule('keywords', e.target.value.split(',').map((s) => s.trim()).filter(Boolean)),
                  }),
                )
              }),
            )),
          h('button', { 'data-qqsl-btn': '', onClick: saveRules, style: { marginTop: '6px' } }, '保存审核规则'),
        ),
        msg ? h('div', { 'data-qqsl-note': '' }, msg) : null,
      )
    }

    if (reg && !reg.some((x) => x && x.id === 'qq')) {
      reg.push({ id: 'qq', label: 'QQ', order: 10, render: QqPanel })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-her-qq-bridge-sl')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'qq-bridge-sl: style')
      },
    }
  },
})

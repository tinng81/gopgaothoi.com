// #!zh: 导出独立 HTML 的 serverless 表单收集端点（Cloudflare Pages Functions）。
//       导出的页面（site/*.html）通过 engine.ejs 注入的 window.__formEndpoint='/api/rsvp'
//       将表单 POST 到本文件（同源），写入 D1（绑定名 DB，见 wrangler.toml / 项目设置），
//       RSVP 收集完全脱离鲁班 Strapi 后端。
//       读取提交记录：GET /api/rsvp?work=<id>&format=json|csv，需带 x-admin-key 头
//       （或 ?key=），值等于 Pages 项目里配置的加密环境变量 ADMIN_KEY。
// #!en: Serverless form-collection endpoint for exported standalone HTML (Cloudflare
//       Pages Functions). Exported pages (site/*.html) POST forms same-origin to this
//       file via window.__formEndpoint='/api/rsvp' (injected by engine.ejs); records land
//       in D1 (binding DB, see wrangler.toml / project settings) — RSVP collection is
//       fully decoupled from the luban Strapi backend.
//       Reading submissions: GET /api/rsvp?work=<id>&format=json|csv with an
//       x-admin-key header (or ?key=) matching the ADMIN_KEY encrypted env var.

const MAX_BODY_BYTES = 16 * 1024
const MAX_VALUE_CHARS = 2000

// #!zh: 基于 D1 的按 IP 限流（与 wish.js 共用同一套窗口）。IP 取 CF-Connecting-IP
//       （Cloudflare 注入，客户端伪造不了）；本地 `wrangler pages dev` 没有该头，
//       所有请求共用 'unknown' 桶，反而方便本地验证 429。窗口故意宽松——NAT 家庭
//       多人共用一个 IP 也足够提交，只挡"手动发太多次"的非技术人员，不是反机器人。
//       计数按 IP 全局（不按 work），同一 D1 上的多份请柬共享额度。
// #!en: D1-based per-IP rate limiting (same windows as wish.js). IP comes from
//       CF-Connecting-IP (injected by Cloudflare, not spoofable); local `wrangler pages
//       dev` has no such header so all requests share the 'unknown' bucket — which makes
//       verifying 429 locally easy. Windows are deliberately generous: a household behind
//       one NAT IP still fits comfortably; this only stops non-tech people hammering the
//       form, it is not anti-bot. Counting is global per IP (not per work) — invitations
//       sharing one D1 share the quota.
const RATE_WINDOWS = [
  { max: 10, minutes: 60 },
  { max: 50, minutes: 24 * 60 }
]

async function overRateLimit (db, table, ip) {
  for (const { max, minutes } of RATE_WINDOWS) {
    const { results } = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ip = ? AND created_at > datetime('now', ?)`)
      .bind(ip, `-${minutes} minutes`)
      .all()
    if ((results[0] && results[0].n) >= max) return true
  }
  return false
}

function json (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

function sanitizeData (data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const clean = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== 'string' || key.length > 100) return null
    if (typeof value !== 'string') return null
    if (value.length > MAX_VALUE_CHARS) return null
    clean[key] = value
  }
  return clean
}

export async function onRequestPost (context) {
  const { request, env } = context
  if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" is not configured' }, 500)

  const contentType = (request.headers.get('Content-Type') || '').toLowerCase()
  // JSON-only：同时天然挡掉跨站表单_POST（text/plain 简单请求绕不过这层）
  // JSON-only: cross-site simple-form POSTs (text/plain) cannot pass this gate either
  if (!contentType.includes('application/json')) {
    return json({ ok: false, error: 'Content-Type must be application/json' }, 415)
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'payload too large' }, 413)

  let body
  try {
    body = JSON.parse(raw)
  } catch (e) {
    return json({ ok: false, error: 'invalid JSON' }, 400)
  }

  const data = sanitizeData(body.data)
  if (!data || !Object.keys(data).length) {
    return json({ ok: false, error: 'data must be a non-empty object of short strings' }, 400)
  }

  const work = body.work == null ? '' : String(body.work).slice(0, 100)
  const title = String(body.title == null ? '' : body.title).slice(0, 200)
  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 300)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'

  if (await overRateLimit(env.DB, 'rsvps', ip)) {
    return json({ ok: false, error: 'too many submissions from your address — please try again later' }, 429)
  }

  await env.DB.prepare(
    'INSERT INTO rsvps (work, title, data, user_agent, ip) VALUES (?, ?, ?, ?, ?)'
  ).bind(work, title, JSON.stringify(data), userAgent, ip).run()

  return json({ ok: true })
}

export async function onRequestGet (context) {
  const { request, env } = context
  if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" is not configured' }, 500)
  if (!env.ADMIN_KEY) return json({ ok: false, error: 'ADMIN_KEY env var is not configured' }, 503)

  const url = new URL(request.url)
  const key = request.headers.get('x-admin-key') || url.searchParams.get('key') || ''
  if (key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401)

  const work = url.searchParams.get('work')
  if (!work) return json({ ok: false, error: 'query param "work" is required' }, 400)

  const format = (url.searchParams.get('format') || 'json').toLowerCase()
  const result = await env.DB.prepare(
    'SELECT id, work, title, data, created_at FROM rsvps WHERE work = ? ORDER BY id'
  ).bind(String(work)).all()
  const rows = (result.results || []).map(row => ({
    ...row,
    data: JSON.parse(row.data)
  }))

  if (format === 'csv') {
    const columns = [...new Set(rows.flatMap(row => Object.keys(row.data)))]
    const escape = cell => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`
    const csv = [
      ['id', 'created_at', ...columns].map(escape).join(','),
      ...rows.map(row => [row.id, row.created_at, ...columns.map(c => row.data[c])].map(escape).join(','))
    ].join('\r\n')
    return new Response('\ufeff' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rsvp-work-${encodeURIComponent(work)}.csv"`
      }
    })
  }

  return json({ ok: true, count: rows.length, records: rows })
}

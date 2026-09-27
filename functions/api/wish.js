// #!zh: 导出独立 HTML 的 serverless 祝福收集端点（Cloudflare Pages Functions）。
//       与 RSVP（functions/api/rsvp.js）刻意分离、独立数据表，但共用同一个 D1（绑定 DB）。
//       导出页面通过 engine.ejs 注入的 window.__wishEndpoint='/api/wish' 把祝福
//       POST 到本文件（同源）。载荷：{ work, title, name, message }。
//       读取祝福：GET /api/wish?work=<id>&format=json|csv，需 x-admin-key 头（或 ?key=）
//       等于 Pages 项目的 ADMIN_KEY 加密环境变量。
// #!en: Serverless wish-collection endpoint for exported standalone HTML (Cloudflare
//       Pages Functions). Deliberately separate from RSVP (functions/api/rsvp.js) with
//       its own table, sharing the same D1 (binding DB). Exported pages POST wishes
//       same-origin to this file via window.__wishEndpoint='/api/wish' (injected by
//       engine.ejs). Payload: { work, title, name, message }.
//       Reading wishes: GET /api/wish?work=<id>&format=json|csv with an x-admin-key
//       header (or ?key=) matching the ADMIN_KEY encrypted env var.

const MAX_BODY_BYTES = 16 * 1024
const MAX_NAME_CHARS = 100
const MAX_MESSAGE_CHARS = 1000

// #!zh: 基于 D1 的按 IP 限流（与 rsvp.js 共用同一套窗口）。IP 取 CF-Connecting-IP
//       （Cloudflare 注入，客户端伪造不了）；本地 `wrangler pages dev` 没有该头，
//       所有请求共用 'unknown' 桶，反而方便本地验证 429。窗口故意宽松——NAT 家庭
//       多人共用一个 IP 也足够提交，只挡"手动发太多次"的非技术人员，不是反机器人。
//       计数按 IP 全局（不按 work），同一 D1 上的多份请柬共享额度。
// #!en: D1-based per-IP rate limiting (same windows as rsvp.js). IP comes from
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

function cap (value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export async function onRequestPost (context) {
  const { request, env } = context
  if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" is not configured' }, 500)

  const contentType = (request.headers.get('Content-Type') || '').toLowerCase()
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

  const message = cap(body.message, MAX_MESSAGE_CHARS).trim()
  if (!message) return json({ ok: false, error: 'message is required' }, 400)

  const work = body.work == null ? '' : String(body.work).slice(0, 100)
  const title = cap(body.title, 200)
  const name = cap(body.name, MAX_NAME_CHARS).trim()
  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 300)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'

  if (await overRateLimit(env.DB, 'wishes', ip)) {
    return json({ ok: false, error: 'too many submissions from your address — please try again later' }, 429)
  }

  await env.DB.prepare(
    'INSERT INTO wishes (work, title, name, message, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(work, title, name, message, userAgent, ip).run()

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
    'SELECT id, work, name, message, created_at FROM wishes WHERE work = ? ORDER BY id'
  ).bind(String(work)).all()
  const rows = result.results || []

  if (format === 'csv') {
    const escape = cell => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`
    const csv = [
      ['id', 'created_at', 'name', 'message'].map(escape).join(','),
      ...rows.map(row => [row.id, row.created_at, row.name, row.message].map(escape).join(','))
    ].join('\r\n')
    return new Response('\ufeff' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="wishes-work-${encodeURIComponent(work)}.csv"`
      }
    })
  }

  return json({ ok: true, count: rows.length, records: rows })
}

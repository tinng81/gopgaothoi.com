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

  await env.DB.prepare(
    'INSERT INTO rsvps (work, title, data, user_agent) VALUES (?, ?, ?, ?)'
  ).bind(work, title, JSON.stringify(data), userAgent).run()

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

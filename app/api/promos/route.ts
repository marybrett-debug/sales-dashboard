import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'

// Shared promo approval for the Marketing dashboard's Promos tab (Airtable <-> dashboard).
// Ported from the standalone dashboard's api/promos.js. The Airtable token stays server-side.
//
// ENV VARS (Vercel → Settings → Environment Variables):
//   AIRTABLE_TOKEN  = personal access token, scopes: data.records:read + data.records:write
//   AIRTABLE_BASE   = base id (starts "app…")
//   AIRTABLE_TABLE  = table name (optional, defaults to "Promos")
//
// Without them this returns 503 and the dashboard keeps promos in the browser.

async function verifySession(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT email, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1`
  if (rows.length === 0 || new Date(rows[0].expires_at as string) < new Date()) return null
  return rows[0].email as string
}

type Promo = Record<string, string>
type AirtableRecord = { id: string; fields: Record<string, unknown> }

const str = (v: unknown) => (v == null ? '' : String(v))

// Airtable record -> dashboard promo object
const toPromo = (rec: AirtableRecord): Promo => {
  const f = rec.fields
  const owner = f['Owner'] as { name?: string } | string | undefined
  return {
    id: rec.id,
    wk: str(f['Week']),
    start: str(f['Start date']),
    dates: str(f['Dates label']),
    m: str(f['Month']),
    theme: str(f['Theme']),
    mechanic: str(f['Offer / mechanic']),
    tag: str(f['Tag']),
    hook: str(f['Hook']),
    article: str(f['Article tie-in']),
    channels: Array.isArray(f['Channels']) ? (f['Channels'] as string[]).join(', ') : str(f['Channels']),
    owner: typeof owner === 'object' && owner ? str(owner.name) : str(owner),
    status: str(f['Status']) || 'Idea',
    web: str(f['Website banner']),
    klaviyo: str(f['Klaviyo banner']),
    region: str(f['Region']) || 'both',
  }
}

// dashboard promo object -> Airtable fields (skip Month: it's a formula field)
const toFields = (p: Promo) => {
  const f: Record<string, unknown> = {
    'Week': p.wk, 'Dates label': p.dates, 'Theme': p.theme, 'Offer / mechanic': p.mechanic,
    'Tag': p.tag, 'Hook': p.hook, 'Article tie-in': p.article, 'Status': p.status,
    'Website banner': p.web, 'Klaviyo banner': p.klaviyo, 'Region': p.region,
  }
  if (p.start) f['Start date'] = p.start
  if (p.channels) f['Channels'] = String(p.channels).split(',').map(s => s.trim()).filter(Boolean)
  if (p.owner) f['Owner'] = p.owner
  return f
}

function airtable() {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE } = process.env
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE) return null
  const table = process.env.AIRTABLE_TABLE || 'Promos'
  return {
    base: `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`,
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
  }
}

export async function GET(req: NextRequest) {
  if (!(await verifySession(req))) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const at = airtable()
  if (!at) return NextResponse.json({ error: 'Airtable not configured' }, { status: 503 })
  try {
    let records: AirtableRecord[] = []
    let offset: string | undefined
    do {
      const u = new URL(at.base)
      u.searchParams.set('pageSize', '100')
      if (offset) u.searchParams.set('offset', offset)
      const r = await fetch(u, { headers: at.headers, cache: 'no-store' })
      const j = await r.json()
      if (!r.ok) return NextResponse.json(j, { status: 502 })
      records = records.concat(j.records || [])
      offset = j.offset
    } while (offset)
    return NextResponse.json({ promos: records.map(toPromo) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[promos GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load promos' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await verifySession(req))) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const at = airtable()
  if (!at) return NextResponse.json({ error: 'Airtable not configured' }, { status: 503 })
  try {
    const body = (await req.json()) as { action?: string; id?: string; status?: string; promo?: Promo }
    const call = async (url: string, method: string, payload?: unknown) => {
      const r = await fetch(url, { method, headers: at.headers, body: payload ? JSON.stringify(payload) : undefined })
      const j = await r.json()
      return { ok: r.ok, j }
    }

    if (body.action === 'status' && body.id) {
      const { ok, j } = await call(`${at.base}/${body.id}`, 'PATCH', { fields: { Status: body.status } })
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json(j, { status: 502 })
    }
    if (body.action === 'create' && body.promo) {
      const { ok, j } = await call(at.base, 'POST', { fields: toFields(body.promo) })
      return ok ? NextResponse.json({ promo: toPromo(j) }) : NextResponse.json(j, { status: 502 })
    }
    if (body.action === 'update' && body.id && body.promo) {
      const { ok, j } = await call(`${at.base}/${body.id}`, 'PATCH', { fields: toFields(body.promo) })
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json(j, { status: 502 })
    }
    if (body.action === 'delete' && body.id) {
      const { ok, j } = await call(`${at.base}/${body.id}`, 'DELETE')
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json(j, { status: 502 })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('[promos POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Promo update failed' }, { status: 500 })
  }
}

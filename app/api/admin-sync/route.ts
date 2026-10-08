import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { adminSession, fetchOrders, missingAdminEnv, addDays, AdminError } from '@/lib/admin'

/*
 * Sync USA retail orders straight from admin.barneysfarm.us into sd_orders.
 * Synced orders live in one sd_files row per year ("Admin sync 2026") and replace any
 * uploaded retail orders for the same dates, so uploads and syncs never double-count.
 *
 * GET  (dashboard session)        → is the sync set up, and the last run
 * GET  (Vercel cron, CRON_SECRET) → run the default sync
 * POST (dashboard session)        → run a sync; body { since?, until?, startPage? } to backfill
 */

export const maxDuration = 60

const REGION = 'usa'
const DEFAULT_DAYS = 35
const OVERLAP_DAYS = 3

async function verifySession(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT email, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1`
  if (rows.length === 0 || new Date(rows[0].expires_at as string) < new Date()) return null
  return rows[0].email as string
}

function isCron(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

async function ensureTables() {
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    CREATE TABLE IF NOT EXISTS sd_admin_sync_runs (
      id         SERIAL PRIMARY KEY,
      ran_at     TIMESTAMPTZ DEFAULT NOW(),
      ran_by     TEXT NOT NULL,
      ok         BOOLEAN NOT NULL,
      complete   BOOLEAN NOT NULL DEFAULT FALSE,
      date_from  DATE,
      date_to    DATE,
      orders     INTEGER NOT NULL DEFAULT 0,
      message    TEXT NOT NULL DEFAULT ''
    )
  `
}

async function lastRun() {
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT ran_at, ran_by, ok, complete, date_from, date_to, orders, message FROM sd_admin_sync_runs ORDER BY id DESC LIMIT 1`
  return rows[0] || null
}

async function defaultSince() {
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT ran_at FROM sd_admin_sync_runs WHERE ok AND complete AND date_to IS NULL ORDER BY id DESC LIMIT 1`
  const from = rows[0] ? new Date(rows[0].ran_at as string) : new Date(Date.now() - DEFAULT_DAYS * 864e5)
  return addDays(from.toISOString().slice(0, 10), rows[0] ? -OVERLAP_DAYS : 0)
}

/* Replace retail orders dated [from, to] with the synced ones. */
async function saveOrders(orders: { date: string; subtotal: number; total: number; clientName: string }[], from: string, to: string, by: string) {
  const sql = neon(process.env.DATABASE_URL!)
  const firstYear = Number(from.slice(0, 4)), lastYear = Number(to.slice(0, 4))
  for (let year = firstYear; year <= lastYear; year++) {
    const lo = from > `${year}-01-01` ? from : `${year}-01-01`
    const hi = to < `${year}-12-31` ? to : `${year}-12-31`
    const yearOrders = orders.filter(o => o.date >= lo && o.date <= hi)
    const filename = `Admin sync ${year}`

    const [file] = await sql`
      INSERT INTO sd_files (filename, region, channel, file_type, uploaded_by)
      VALUES (${filename}, ${REGION}, 'retail', 'orders', ${by})
      ON CONFLICT (region, filename) DO UPDATE SET uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()
      RETURNING id
    `
    const fileId = file.id as number

    // Drop this file's orders and any uploaded retail orders for the same dates
    await sql`
      DELETE FROM sd_orders o USING sd_files f
      WHERE o.file_id = f.id AND f.region = ${REGION} AND o.channel = 'retail'
        AND o.order_date >= ${lo}::date AND o.order_date <= ${hi}::date
    `
    if (yearOrders.length > 0) {
      const rows = JSON.stringify(yearOrders.map(o => ({ d: o.date, s: o.subtotal, t: o.total, n: o.clientName })))
      await sql`
        INSERT INTO sd_orders (file_id, order_date, subtotal, total, tax, channel, is_count_only, order_count, client_name)
        SELECT ${fileId}, x.d, x.s, x.t, 0, 'retail', FALSE, 1, COALESCE(x.n, '')
        FROM jsonb_to_recordset(${rows}::jsonb) AS x(d date, s numeric, t numeric, n text)
      `
    }
  }
  // Uploaded files left with nothing in them
  await sql`
    DELETE FROM sd_files WHERE region = ${REGION}
      AND NOT EXISTS (SELECT 1 FROM sd_orders WHERE file_id = sd_files.id)
      AND NOT EXISTS (SELECT 1 FROM sd_strains WHERE file_id = sd_files.id)
  `
}

async function runSync(by: string, body: { since?: string; until?: string; startPage?: number }) {
  const sql = neon(process.env.DATABASE_URL!)
  const missing = missingAdminEnv()
  if (missing.length) return { status: 503, json: { error: `The admin sync isn't set up yet. Missing: ${missing.join(', ')}.` } }

  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const since = isDate(body.since) ? body.since! : await defaultSince()
  const until = isDate(body.until) ? body.until : undefined
  const today = new Date().toISOString().slice(0, 10)

  try {
    const admin = await adminSession()
    const res = await fetchOrders(admin, { since, until, startPage: body.startPage, deadline: Date.now() + 40_000 })
    const retail = res.orders.filter(o => o.channel === 'retail')
    const wholesaleSkipped = res.orders.length - retail.length
    const to = res.until || today
    if (res.orders.length === 0 && addDays(res.from, 2) <= to) {
      throw new AdminError(`The admin returned no orders for ${res.from} to ${to}, so the dashboard was left as it was.`)
    }
    if (res.from <= to) await saveOrders(retail, res.from, to, by)

    const message = `${retail.length.toLocaleString('en-US')} retail orders, ${res.from} to ${to}` +
      (wholesaleSkipped ? ` (${wholesaleSkipped} wholesale orders left out)` : '')
    await sql`
      INSERT INTO sd_admin_sync_runs (ran_by, ok, complete, date_from, date_to, orders, message)
      VALUES (${by}, TRUE, ${res.complete}, ${res.from}, ${res.until}, ${retail.length}, ${message})
    `
    return {
      status: 200,
      json: {
        ok: true, complete: res.complete, orders: retail.length, from: res.from, to, message,
        ...(res.complete ? {} : { next: { since, until: res.nextUntil, startPage: res.nextPage } }),
      },
    }
  } catch (e) {
    const message = e instanceof AdminError ? e.message : `Could not reach the admin: ${(e as Error).message}`
    console.error('[admin-sync]', message)
    await sql`INSERT INTO sd_admin_sync_runs (ran_by, ok, date_from, date_to, message) VALUES (${by}, FALSE, ${since}, ${until ?? null}, ${message})`
    return { status: 502, json: { error: message } }
  }
}

export async function GET(req: NextRequest) {
  await ensureTables()
  if (isCron(req)) {
    const r = await runSync('cron', {})
    return NextResponse.json(r.json, { status: r.status })
  }
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  return NextResponse.json({ missing: missingAdminEnv(), last: await lastRun() })
}

export async function POST(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  await ensureTables()
  const body = await req.json().catch(() => ({}))
  const r = await runSync(email, body)
  return NextResponse.json(r.json, { status: r.status })
}

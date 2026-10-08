import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { adminSession, fetchOrders, missingAdminEnv, AdminError } from '@/lib/admin'
import { ensureTables, lastRun, defaultSince, applyOrders, logFailure, bookmarkletKey } from '@/lib/sales-sync'
import { bookmarkletCode } from '@/lib/bookmarklet'

/*
 * Sync USA retail and wholesale orders straight from admin.barneysfarm.us into sd_orders.
 * Synced orders live in one sd_files row per year ("Admin sync 2026", "Admin sync wholesale 2026") and replace any
 * uploaded orders of the same channel and dates, so uploads and syncs never double-count.
 *
 * GET  (dashboard session)        → is the sync set up, the last run, and this user's bookmarklet
 * GET  (Vercel cron, CRON_SECRET) → run the default sync
 * POST (dashboard session)        → run a sync; body { since?, until?, startPage? } to backfill
 */

export const maxDuration = 60

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

async function runSync(by: string, body: { since?: string; until?: string; startPage?: number }) {
  const missing = missingAdminEnv()
  if (missing.length) return { status: 503, json: { error: `The admin sync isn't set up yet. Missing: ${missing.join(', ')}.` } }

  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const since = isDate(body.since) ? body.since! : await defaultSince()
  const until = isDate(body.until) ? body.until : undefined
  const today = new Date().toISOString().slice(0, 10)

  try {
    const admin = await adminSession()
    const res = await fetchOrders(admin, { since, until, startPage: body.startPage, deadline: Date.now() + 40_000 })
    const to = res.until || today
    const saved = await applyOrders(res.orders, res.from, to, by, res.complete, res.until)
    return {
      status: 200,
      json: {
        ok: true, complete: res.complete, from: res.from, to, ...saved,
        ...(res.complete ? {} : { next: { since, until: res.nextUntil, startPage: res.nextPage } }),
      },
    }
  } catch (e) {
    const message = e instanceof AdminError ? e.message : `Could not reach the admin: ${(e as Error).message}`
    console.error('[admin-sync]', message)
    await logFailure(by, since, until ?? null, message)
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
  const bookmarklet = bookmarkletCode(req.nextUrl.origin, await bookmarkletKey(email))
  return NextResponse.json({ missing: missingAdminEnv(), last: await lastRun(), bookmarklet })
}

export async function POST(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  await ensureTables()
  const body = await req.json().catch(() => ({}))
  const r = await runSync(email, body)
  return NextResponse.json(r.json, { status: r.status })
}

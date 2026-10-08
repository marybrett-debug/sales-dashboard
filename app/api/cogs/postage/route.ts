import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'

/*
 * Monthly postage summary pulled server-side from ShipDash (/api/shippo/data).
 * Only aggregates leave this route: no names, addresses or tracking numbers.
 * Needs SHIPDASH_URL, SHIPDASH_USERNAME and SHIPDASH_PASSWORD (ShipDash Basic Auth).
 */

async function verifySession(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT email, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1`
  if (rows.length === 0 || new Date(rows[0].expires_at as string) < new Date()) return null
  return rows[0].email as string
}

interface ShipRow { date?: string; amount?: number | string; service?: string; tier?: string }
interface MonthPostage { month: string; labels: number; postage: number; avg: number; priorityShare: number }

const CACHE_MS = 30 * 60 * 1000
let cached: { at: number; months: MonthPostage[]; fetchedAt: number | null } | null = null

function summarise(rows: ShipRow[]): MonthPostage[] {
  const byMonth = new Map<string, { labels: number; postage: number; priority: number }>()
  for (const r of rows) {
    const month = (r.date || '').slice(0, 7)
    const amount = typeof r.amount === 'number' ? r.amount : parseFloat(r.amount || '')
    if (!/^\d{4}-\d{2}$/.test(month) || !isFinite(amount) || amount <= 0) continue
    const m = byMonth.get(month) || { labels: 0, postage: 0, priority: 0 }
    m.labels += 1
    m.postage += amount
    if (/priority/i.test(r.service || '')) m.priority += 1
    byMonth.set(month, m)
  }
  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({
      month,
      labels: m.labels,
      postage: Math.round(m.postage * 100) / 100,
      avg: Math.round((m.postage / m.labels) * 100) / 100,
      priorityShare: Math.round((m.priority / m.labels) * 1000) / 1000,
    }))
}

export async function GET(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const base = process.env.SHIPDASH_URL
  const user = process.env.SHIPDASH_USERNAME
  const pass = process.env.SHIPDASH_PASSWORD
  if (!base || !user || !pass) {
    return NextResponse.json({ error: 'ShipDash is not connected. Set SHIPDASH_URL, SHIPDASH_USERNAME and SHIPDASH_PASSWORD.' }, { status: 503 })
  }

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json({ months: cached.months, fetchedAt: cached.fetchedAt, cached: true })
  }

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/shippo/data`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
      cache: 'no-store',
    })
    if (res.status === 401) return NextResponse.json({ error: 'ShipDash rejected the username or password.' }, { status: 502 })
    if (res.status === 202) return NextResponse.json({ error: 'ShipDash is still loading its first sync. Try again in a few minutes.' }, { status: 503 })
    if (!res.ok) return NextResponse.json({ error: `ShipDash returned ${res.status}.` }, { status: 502 })
    const data = (await res.json()) as { rows?: ShipRow[]; fetched_at?: number }
    const months = summarise(data.rows || [])
    cached = { at: Date.now(), months, fetchedAt: data.fetched_at ?? null }
    return NextResponse.json({ months, fetchedAt: cached.fetchedAt, cached: false })
  } catch (e) {
    return NextResponse.json({ error: `Could not reach ShipDash: ${(e as Error).message}` }, { status: 502 })
  }
}

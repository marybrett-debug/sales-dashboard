import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'

async function verifySession(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT email, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1`
  if (rows.length === 0 || new Date(rows[0].expires_at as string) < new Date()) return null
  return rows[0].email as string
}

async function ensureTable() {
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    CREATE TABLE IF NOT EXISTS cogs_settings (
      id         TEXT PRIMARY KEY,
      inputs     JSONB NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
}

/* ── GET: saved COGS inputs (null if never saved) ─────────── */

export async function GET(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  try {
    await ensureTable()
    const sql = neon(process.env.DATABASE_URL!)
    const rows = await sql`SELECT inputs, updated_by, updated_at FROM cogs_settings WHERE id = 'usa' LIMIT 1`
    if (rows.length === 0) return NextResponse.json({ inputs: null })
    return NextResponse.json({ inputs: rows[0].inputs, updatedBy: rows[0].updated_by, updatedAt: rows[0].updated_at })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/* ── PUT: save COGS inputs ────────────────────────────────── */

export async function PUT(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  try {
    const { inputs } = (await req.json()) as { inputs?: unknown }
    if (!inputs || typeof inputs !== 'object') return NextResponse.json({ error: 'inputs is required' }, { status: 400 })
    await ensureTable()
    const sql = neon(process.env.DATABASE_URL!)
    await sql`
      INSERT INTO cogs_settings (id, inputs, updated_by, updated_at)
      VALUES ('usa', ${JSON.stringify(inputs)}::jsonb, ${email}, NOW())
      ON CONFLICT (id) DO UPDATE SET inputs = EXCLUDED.inputs, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

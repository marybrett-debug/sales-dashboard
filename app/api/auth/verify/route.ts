import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import crypto from 'crypto'

export async function POST(req: NextRequest) {
  try {
    const { token } = (await req.json()) as { token?: string }
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 })
    }

    const sql = neon(process.env.DATABASE_URL!)

    const rows = await sql`
      SELECT email, expires_at, used FROM auth_tokens WHERE token = ${token} LIMIT 1
    `
    if (rows.length === 0) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })

    const row = rows[0]
    if (row.used) return NextResponse.json({ error: 'This link has already been used' }, { status: 401 })
    if (new Date(row.expires_at as string) < new Date()) return NextResponse.json({ error: 'This link has expired' }, { status: 401 })

    await sql`UPDATE auth_tokens SET used = TRUE WHERE token = ${token}`

    const sessionToken = crypto.randomBytes(32).toString('hex')
    const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await sql`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id SERIAL PRIMARY KEY, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `

    await sql`
      INSERT INTO auth_sessions (email, token, expires_at)
      VALUES (${row.email}, ${sessionToken}, ${sessionExpires.toISOString()})
    `

    return NextResponse.json({ success: true, session: sessionToken, email: row.email, expiresAt: sessionExpires.toISOString() })
  } catch (err) {
    console.error('[auth/verify]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const sessionToken = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!sessionToken) return NextResponse.json({ authenticated: false }, { status: 401 })

    const sql = neon(process.env.DATABASE_URL!)
    const rows = await sql`SELECT email, expires_at FROM auth_sessions WHERE token = ${sessionToken} LIMIT 1`

    if (rows.length === 0 || new Date(rows[0].expires_at as string) < new Date()) {
      return NextResponse.json({ authenticated: false }, { status: 401 })
    }

    return NextResponse.json({ authenticated: true, email: rows[0].email })
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }
}

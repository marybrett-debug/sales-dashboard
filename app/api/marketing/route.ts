import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { readFile } from 'fs/promises'
import path from 'path'

// The marketing dashboard is a self-contained HTML file kept out of /public so it
// is only served to signed-in users. The client renders it in an iframe.

async function verifySession(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT email, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1`
  if (rows.length === 0 || new Date(rows[0].expires_at as string) < new Date()) return null
  return rows[0].email as string
}

export async function GET(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  try {
    const html = await readFile(path.join(process.cwd(), 'app/api/marketing/dashboard.html'), 'utf8')
    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    console.error('[marketing GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to load marketing dashboard' }, { status: 500 })
  }
}

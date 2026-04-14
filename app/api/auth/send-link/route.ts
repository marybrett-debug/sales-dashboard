import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import sgMail from '@sendgrid/mail'
import crypto from 'crypto'

const ALLOWED_EMAILS = new Set([
  'mary@barneysfarm.com',
  'derry@barneysfarm.com',
  'sissi@barneysfarm.com',
  'mary.brett@gmail.com',
  'brett.dermot@gmail.com',
])

export async function POST(req: NextRequest) {
  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Email service not configured' }, { status: 500 })
  }

  try {
    const { email } = (await req.json()) as { email?: string }
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const normalised = email.toLowerCase().trim()

    if (!ALLOWED_EMAILS.has(normalised)) {
      return NextResponse.json({ success: true, message: 'If that email is authorised, a login link has been sent.' })
    }

    const sql = neon(process.env.DATABASE_URL!)

    await sql`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id         SERIAL PRIMARY KEY,
        email      TEXT NOT NULL,
        token      TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    await sql`
      INSERT INTO auth_tokens (email, token, expires_at)
      VALUES (${normalised}, ${token}, ${expiresAt.toISOString()})
    `

    const baseUrl = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/[^/]*$/, '') || 'https://sales-dashboard.vercel.app'
    const magicLink = `${baseUrl}?token=${token}`

    sgMail.setApiKey(apiKey)
    await sgMail.send({
      from: { email: 'mary.brett@gmail.com', name: "Barney's Farm Dashboard" },
      to: normalised,
      subject: 'Your Dashboard Login Link',
      text: `Hi,\n\nClick here to access the Barney's Farm Sales Dashboard:\n\n${magicLink}\n\nThis link expires in 15 minutes.\n\n— Barney's Farm`,
      html: `<p>Hi,</p><p>Click below to access the Barney's Farm Sales Dashboard:</p><p><a href="${magicLink}" style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Open Dashboard</a></p><p style="color:#666;font-size:13px;">Expires in 15 minutes, single use.</p><p style="color:#999;font-size:11px;">${magicLink}</p>`,
    })

    return NextResponse.json({ success: true, message: 'If that email is authorised, a login link has been sent.' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[auth/send-link]', message)
    return NextResponse.json({ error: 'Failed to send login link' }, { status: 500 })
  }
}

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

async function ensureTables() {
  const sql = neon(process.env.DATABASE_URL!)

  await sql`
    CREATE TABLE IF NOT EXISTS sd_files (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL,
      region     TEXT NOT NULL DEFAULT 'usa',
      channel    TEXT NOT NULL,
      file_type  TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS sd_files_region_filename ON sd_files(region, filename)`

  await sql`
    CREATE TABLE IF NOT EXISTS sd_orders (
      id         SERIAL PRIMARY KEY,
      file_id    INTEGER NOT NULL REFERENCES sd_files(id) ON DELETE CASCADE,
      order_date DATE NOT NULL,
      subtotal   NUMERIC NOT NULL DEFAULT 0,
      total      NUMERIC NOT NULL DEFAULT 0,
      tax        NUMERIC NOT NULL DEFAULT 0,
      channel    TEXT NOT NULL,
      is_count_only BOOLEAN DEFAULT FALSE,
      order_count INTEGER NOT NULL DEFAULT 1
    )
  `
  await sql`ALTER TABLE sd_orders ADD COLUMN IF NOT EXISTS order_count INTEGER NOT NULL DEFAULT 1`
  await sql`ALTER TABLE sd_orders ADD COLUMN IF NOT EXISTS client_name TEXT NOT NULL DEFAULT ''`
  await sql`CREATE INDEX IF NOT EXISTS idx_sd_orders_file ON sd_orders(file_id)`
  await sql`DROP INDEX IF EXISTS idx_sd_orders_dedup`

  await sql`
    CREATE TABLE IF NOT EXISTS sd_strains (
      id         SERIAL PRIMARY KEY,
      file_id    INTEGER NOT NULL REFERENCES sd_files(id) ON DELETE CASCADE,
      item       TEXT NOT NULL,
      strain     TEXT NOT NULL,
      pack_size  TEXT NOT NULL DEFAULT '',
      sold       NUMERIC NOT NULL DEFAULT 0,
      subtotal   NUMERIC NOT NULL DEFAULT 0,
      channel    TEXT NOT NULL,
      year       INTEGER NOT NULL
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_sd_strains_file ON sd_strains(file_id)`
  await sql`DROP INDEX IF EXISTS idx_sd_strains_dedup`
}

/* ── POST: save uploaded data ─────────────────────────────── */

interface SaveBody {
  filename: string
  region: string
  channel: 'retail' | 'wholesale' | 'bulk'
  fileType: 'orders' | 'seeds' | 'daily'
  orders?: { date: string; subtotal: number; total: number; tax: number; channel: string; isCountOnly?: boolean; orderCount?: number; clientName?: string }[]
  strains?: { item: string; strain: string; packSize: string; sold: number; subtotal: number; channel: string; year: number }[]
}

export async function POST(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  try {
    await ensureTables()
    const sql = neon(process.env.DATABASE_URL!)
    const body = (await req.json()) as SaveBody
    const region = body.region || 'usa'

    // If same filename was already uploaded, reuse that record; otherwise create new
    let fileId: number
    const existing = await sql`
      SELECT id FROM sd_files WHERE filename = ${body.filename} AND region = ${region}
    `
    if (existing.length > 0) {
      fileId = existing[0].id as number
      await sql`DELETE FROM sd_orders WHERE file_id = ${fileId}`
      await sql`DELETE FROM sd_strains WHERE file_id = ${fileId}`
      await sql`UPDATE sd_files SET uploaded_by = ${email}, uploaded_at = NOW() WHERE id = ${fileId}`
    } else {
      const [fileRow] = await sql`
        INSERT INTO sd_files (filename, region, channel, file_type, uploaded_by)
        VALUES (${body.filename}, ${region}, ${body.channel}, ${body.fileType}, ${email})
        RETURNING id
      `
      fileId = fileRow.id as number
    }

    if (body.orders && body.orders.length > 0) {
      // Find the date range of the new file
      const dates = body.orders.map(o => o.date).sort()
      const minDate = dates[0]
      const maxDate = dates[dates.length - 1]
      const orderChannel = body.orders[0].channel

      // Delete overlapping orders from OTHER files in the same region+channel+date range
      // This prevents duplicates when re-exporting reports with different filenames
      const otherFileIds = await sql`
        SELECT id FROM sd_files
        WHERE region = ${region} AND id != ${fileId} AND channel = ${body.channel}
      `
      if (otherFileIds.length > 0) {
        const ids = otherFileIds.map(f => f.id as number)
        await sql`
          DELETE FROM sd_orders
          WHERE file_id = ANY(${ids})
            AND channel = ${orderChannel}
            AND order_date >= ${minDate}::date
            AND order_date <= ${maxDate}::date
        `
      }

      const batchSize = 200
      for (let i = 0; i < body.orders.length; i += batchSize) {
        const batch = body.orders.slice(i, i + batchSize)
        const values = batch.map(o =>
          `(${fileId}, '${o.date}', ${o.subtotal}, ${o.total}, ${o.tax}, '${o.channel}', ${o.isCountOnly ? 'TRUE' : 'FALSE'}, ${o.orderCount || 1}, '${(o.clientName || '').replace(/'/g, "''")}')`
        ).join(',')
        await sql(`INSERT INTO sd_orders (file_id, order_date, subtotal, total, tax, channel, is_count_only, order_count, client_name) VALUES ${values}`)
      }
    }

    if (body.strains && body.strains.length > 0) {
      // Delete overlapping strains from OTHER files (same region+channel+year)
      const years = [...new Set(body.strains.map(s => s.year))]
      const strainChannel = body.strains[0].channel
      const otherFileIds = await sql`
        SELECT id FROM sd_files
        WHERE region = ${region} AND id != ${fileId} AND channel = ${body.channel}
      `
      if (otherFileIds.length > 0) {
        const ids = otherFileIds.map(f => f.id as number)
        await sql`
          DELETE FROM sd_strains
          WHERE file_id = ANY(${ids})
            AND channel = ${strainChannel}
            AND year = ANY(${years})
        `
      }

      const batchSize = 200
      for (let i = 0; i < body.strains.length; i += batchSize) {
        const batch = body.strains.slice(i, i + batchSize)
        const values = batch.map(s =>
          `(${fileId}, '${s.item.replace(/'/g, "''")}', '${s.strain.replace(/'/g, "''")}', '${s.packSize.replace(/'/g, "''")}', ${s.sold}, ${s.subtotal}, '${s.channel}', ${s.year})`
        ).join(',')
        await sql(`INSERT INTO sd_strains (file_id, item, strain, pack_size, sold, subtotal, channel, year) VALUES ${values}`)
      }
    }

    // Clean up any files that now have no orders and no strains
    await sql`
      DELETE FROM sd_files WHERE region = ${region} AND id != ${fileId}
        AND NOT EXISTS (SELECT 1 FROM sd_orders WHERE file_id = sd_files.id)
        AND NOT EXISTS (SELECT 1 FROM sd_strains WHERE file_id = sd_files.id)
    `

    return NextResponse.json({ success: true, fileId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dashboard/save]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/* ── GET: load data for a region ──────────────────────────── */

export async function GET(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  try {
    await ensureTables()
    const sql = neon(process.env.DATABASE_URL!)
    const region = req.nextUrl.searchParams.get('region') || 'usa'

    const files = await sql`
      SELECT id, filename, channel, file_type, uploaded_by, uploaded_at
      FROM sd_files WHERE region = ${region} ORDER BY uploaded_at
    `

    if (files.length === 0) return NextResponse.json({ files: [], orders: [], strains: [] })

    const fileIds = files.map(f => f.id as number)

    const orders = await sql`
      SELECT o.file_id, o.order_date, o.subtotal, o.total, o.tax, o.channel, o.is_count_only, o.order_count, o.client_name, f.filename
      FROM sd_orders o JOIN sd_files f ON f.id = o.file_id
      WHERE o.file_id = ANY(${fileIds}) ORDER BY o.order_date
    `

    const strains = await sql`
      SELECT s.file_id, s.item, s.strain, s.pack_size, s.sold, s.subtotal, s.channel, s.year, f.filename
      FROM sd_strains s JOIN sd_files f ON f.id = s.file_id
      WHERE s.file_id = ANY(${fileIds})
    `

    return NextResponse.json({ files, orders, strains })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dashboard/load]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/* ── DELETE: clear data for a region ──────────────────────── */

export async function DELETE(req: NextRequest) {
  const email = await verifySession(req)
  if (!email) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const region = req.nextUrl.searchParams.get('region') || 'usa'
    await sql`DELETE FROM sd_files WHERE region = ${region}`
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dashboard/delete]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

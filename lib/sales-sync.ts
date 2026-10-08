import { neon } from '@neondatabase/serverless'
import { addDays, AdminError, type AdminOrder } from '@/lib/admin'

/* Storing synced admin orders, shared by the server pull and the browser bookmarklet. */

const REGION = 'usa'
const DEFAULT_DAYS = 35
const OVERLAP_DAYS = 3

export async function ensureTables() {
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
  await sql`
    CREATE TABLE IF NOT EXISTS sd_admin_sync_keys (
      key        TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
}

export async function lastRun() {
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT ran_at, ran_by, ok, complete, date_from, date_to, orders, message FROM sd_admin_sync_runs ORDER BY id DESC LIMIT 1`
  return rows[0] || null
}

export async function defaultSince() {
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT ran_at FROM sd_admin_sync_runs WHERE ok AND complete AND date_to IS NULL ORDER BY id DESC LIMIT 1`
  const from = rows[0] ? new Date(rows[0].ran_at as string) : new Date(Date.now() - DEFAULT_DAYS * 864e5)
  return addDays(from.toISOString().slice(0, 10), rows[0] ? -OVERLAP_DAYS : 0)
}

type Channel = AdminOrder['channel']

/* Replace one channel's orders dated [from, to] with the synced ones. */
export async function saveOrders(orders: { date: string; subtotal: number; total: number; clientName: string }[], channel: Channel, from: string, to: string, by: string) {
  const sql = neon(process.env.DATABASE_URL!)
  const firstYear = Number(from.slice(0, 4)), lastYear = Number(to.slice(0, 4))
  for (let year = firstYear; year <= lastYear; year++) {
    const lo = from > `${year}-01-01` ? from : `${year}-01-01`
    const hi = to < `${year}-12-31` ? to : `${year}-12-31`
    const yearOrders = orders.filter(o => o.date >= lo && o.date <= hi)
    const filename = channel === 'retail' ? `Admin sync ${year}` : `Admin sync ${channel} ${year}`

    const [file] = await sql`
      INSERT INTO sd_files (filename, region, channel, file_type, uploaded_by)
      VALUES (${filename}, ${REGION}, ${channel}, 'orders', ${by})
      ON CONFLICT (region, filename) DO UPDATE SET uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()
      RETURNING id
    `
    const fileId = file.id as number

    // Drop this file's orders and any uploaded orders of this channel for the same dates
    await sql`
      DELETE FROM sd_orders o USING sd_files f
      WHERE o.file_id = f.id AND f.region = ${REGION} AND o.channel = ${channel}
        AND o.order_date >= ${lo}::date AND o.order_date <= ${hi}::date
    `
    if (yearOrders.length > 0) {
      const rows = JSON.stringify(yearOrders.map(o => ({ d: o.date, s: o.subtotal, t: o.total, n: o.clientName })))
      await sql`
        INSERT INTO sd_orders (file_id, order_date, subtotal, total, tax, channel, is_count_only, order_count, client_name)
        SELECT ${fileId}, x.d, x.s, x.t, 0, ${channel}, FALSE, 1, COALESCE(x.n, '')
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


export async function bookmarkletKey(email: string) {
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT key FROM sd_admin_sync_keys WHERE email = ${email} LIMIT 1`
  if (rows[0]) return rows[0].key as string
  const key = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await sql`INSERT INTO sd_admin_sync_keys (key, email) VALUES (${key}, ${email})`
  return key
}

export async function emailForKey(key: string) {
  if (!key) return null
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`SELECT email FROM sd_admin_sync_keys WHERE key = ${key} LIMIT 1`
  return (rows[0]?.email as string) || null
}

/* Save orders read in full for [from, to] and log the run. Throws AdminError when it refuses. */
export async function applyOrders(orders: AdminOrder[], from: string, to: string, by: string, complete: boolean, until: string | null) {
  const sql = neon(process.env.DATABASE_URL!)
  if (orders.length === 0 && addDays(from, 2) <= to) {
    throw new AdminError(`The admin returned no orders for ${from} to ${to}, so the dashboard was left as it was.`)
  }
  const retail = orders.filter(o => o.channel === 'retail')
  const wholesale = orders.filter(o => o.channel === 'wholesale')
  if (from <= to) {
    await saveOrders(retail, 'retail', from, to, by)
    await saveOrders(wholesale, 'wholesale', from, to, by)
  }
  const n = (x: number) => x.toLocaleString('en-US')
  const message = `${n(retail.length)} retail and ${n(wholesale.length)} wholesale orders, ${from} to ${to}`
  await sql`
    INSERT INTO sd_admin_sync_runs (ran_by, ok, complete, date_from, date_to, orders, message)
    VALUES (${by}, TRUE, ${complete}, ${from}, ${until}, ${orders.length}, ${message})
  `
  return { orders: orders.length, message }
}

export async function logFailure(by: string, since: string | null, until: string | null, message: string) {
  const sql = neon(process.env.DATABASE_URL!)
  await sql`INSERT INTO sd_admin_sync_runs (ran_by, ok, date_from, date_to, message) VALUES (${by}, FALSE, ${since}, ${until}, ${message})`
}

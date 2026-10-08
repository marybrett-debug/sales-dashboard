/*
 * Pull orders from the US admin (admin.barneysfarm.us, Bagisto) on the server.
 *
 * The admin sits behind Cloudflare Access, so every request carries a Cloudflare Access
 * service token, then we sign in to Bagisto with an admin user (same flow as Seed Forecast's
 * "Sync from admin"). Env vars:
 *   ADMIN_URL                 (optional, default https://admin.barneysfarm.us)
 *   CF_ACCESS_CLIENT_ID       Cloudflare Access service token Client ID
 *   CF_ACCESS_CLIENT_SECRET   Cloudflare Access service token Client Secret
 *   ADMIN_EMAIL               admin user for the sync
 *   ADMIN_PASSWORD
 *
 * Orders come from the Sales → Orders grid (/admin/sales/orders), newest first, read
 * page by page until we pass the start date or run out of time.
 */

export interface AdminOrder { ref: string; date: string; subtotal: number; total: number; status: string; clientName: string; channel: 'retail' | 'wholesale' }

const REQUIRED_ENV = ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'] as const
const SKIP_STATUSES = /cancel|closed|fraud|refund/i
export const isLiveOrder = (o: AdminOrder) => !SKIP_STATUSES.test(o.status)

export function missingAdminEnv(): string[] {
  return REQUIRED_ENV.filter(k => !process.env[k])
}

export class AdminError extends Error {}

export async function adminSession() {
  const base = (process.env.ADMIN_URL || 'https://admin.barneysfarm.us').replace(/\/$/, '')
  const jar = new Map<string, string>()
  const cf = {
    'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID || '',
    'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET || '',
  }

  async function req(path: string, opts: RequestInit = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await fetch(base + path, {
      ...opts,
      redirect: 'manual',
      cache: 'no-store',
      headers: { ...cf, Cookie: cookie, ...(opts.headers as Record<string, string> || {}) },
    })
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
    const loc = r.headers.get('location') || ''
    if (r.status >= 300 && r.status < 400 && /cloudflareaccess\.com/.test(loc)) {
      throw new AdminError('Cloudflare Access turned the sync away. Check the service token, and that the admin.barneysfarm.us Access application has a Service Auth policy that includes it.')
    }
    if (r.status === 403 && /cloudflare/i.test(r.headers.get('server') || '')) {
      throw new AdminError('Cloudflare Access refused the service token (HTTP 403). Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET and the Service Auth policy.')
    }
    return r
  }

  // 1. login page → CSRF token
  let r = await req('/admin/login')
  if (r.status >= 300 && r.status < 400) r = await req(new URL(r.headers.get('location')!, base).pathname)
  const html = await r.text()
  const tok = /name="_token"\s+value="([^"]+)"/.exec(html) || /csrf-token"\s+content="([^"]+)"/.exec(html)
  if (!tok) throw new AdminError(`Could not find the admin login form (HTTP ${r.status}).`)

  // 2. sign in
  r = await req('/admin/login', {
    method: 'POST',
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL || '', password: process.env.ADMIN_PASSWORD || '', _token: tok[1] }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base + '/admin/login' },
  })
  const loc = r.headers.get('location') || ''
  if (!(r.status >= 300 && r.status < 400) || /\/admin\/login/.test(loc)) {
    throw new AdminError('The admin rejected ADMIN_EMAIL / ADMIN_PASSWORD.')
  }

  return {
    async json(path: string) {
      const g = await req(path, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } })
      if (g.status !== 200) throw new AdminError(`${path.split('?')[0]} returned HTTP ${g.status}.`)
      return g.json()
    },
  }
}

/* ── record parsing (grid cells can be raw values or formatted HTML) ── */

const stripHtml = (v: unknown) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

function money(v: unknown): number | null {
  if (typeof v === 'number') return v
  const s = stripHtml(v).replace(/[^0-9.\-]/g, '')
  if (!s) return null
  const n = parseFloat(s)
  return isFinite(n) ? n : null
}

function isoDate(v: unknown): string | null {
  const s = stripHtml(v)
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function pick(rec: Record<string, unknown>, keys: string[]) {
  for (const k of keys) if (rec[k] !== undefined && rec[k] !== null && rec[k] !== '') return rec[k]
  return undefined
}

// Grid columns each order field can come from, in order of preference
export const ORDER_COLUMNS = {
  created_at: ['created_at', 'order_date', 'date'],
  base_sub_total: ['base_sub_total', 'sub_total', 'base_subtotal', 'subtotal'],
  base_grand_total: ['base_grand_total', 'grand_total'],
  status: ['status', 'status_label'],
  full_name: ['full_name', 'customer_name', 'billed_to'],
  channel_name: ['channel_name', 'channel'],
  increment_id: ['increment_id', 'id'],
}

export function parseOrder(rec: Record<string, unknown>): AdminOrder | null {
  const date = isoDate(pick(rec, ORDER_COLUMNS.created_at))
  const total = money(pick(rec, ORDER_COLUMNS.base_grand_total))
  const subtotal = money(pick(rec, ORDER_COLUMNS.base_sub_total)) ?? total
  if (!date || total === null || subtotal === null) return null
  const ref = stripHtml(pick(rec, ORDER_COLUMNS.increment_id))
  const channelName = stripHtml(pick(rec, ORDER_COLUMNS.channel_name))
  return {
    ref,
    date,
    subtotal,
    total,
    status: stripHtml(pick(rec, ORDER_COLUMNS.status)).toLowerCase(),
    clientName: stripHtml(pick(rec, ORDER_COLUMNS.full_name)),
    channel: /wholesale|b2b/i.test(channelName) || /^B2B/i.test(ref) ? 'wholesale' : 'retail',
  }
}

/*
 * Read orders dated within [since, until] (inclusive), newest first, starting at `startPage`.
 * Stops at `deadline`; then `complete` is false and the caller resumes with `nextPage` / `nextUntil`.
 * Only dates that were read in full are returned, so a resumed run never double-counts.
 */
export async function fetchOrders(
  admin: Awaited<ReturnType<typeof adminSession>>,
  opts: { since: string; until?: string; startPage?: number; deadline: number },
) {
  const perPage = 100
  const orders: AdminOrder[] = []
  let page = opts.startPage || 1
  let lastPage = page
  let oldest: string | null = null
  let complete = false

  while (true) {
    const j = await admin.json(`/admin/sales/orders?pagination[per_page]=${perPage}&pagination[page]=${page}&sort[column]=created_at&sort[order]=desc`)
    const records: Record<string, unknown>[] = j.records || []
    lastPage = (j.meta && j.meta.last_page) || page
    if (page === (opts.startPage || 1) && records.length > 0) {
      const first = parseOrder(records[0]), last = parseOrder(records[records.length - 1])
      if (!first) throw new AdminError(`The orders grid has columns this sync doesn't recognise: ${Object.keys(records[0]).join(', ')}`)
      // Everything below relies on newest-first; never replace data from a list in another order
      if (last && first.date < last.date) throw new AdminError('The orders grid did not come back newest first, so nothing was changed.')
    }
    for (const rec of records) {
      const o = parseOrder(rec)
      if (!o) continue
      if (!oldest || o.date < oldest) oldest = o.date
      if (o.date < opts.since || (opts.until && o.date > opts.until)) continue
      if (!isLiveOrder(o)) continue
      orders.push(o)
    }
    page++
    if (records.length === 0 || page > lastPage || (oldest && oldest < opts.since)) { complete = true; break }
    // Read at least two pages so a resumed run always gets past the page it restarted on
    if (Date.now() > opts.deadline && page - (opts.startPage || 1) >= 2) break
  }

  if (complete) return { orders, complete, from: opts.since, until: opts.until || null }

  // Out of time: the oldest date seen may be only partly read, so keep the dates after it
  // and resume on the last page read (new orders push older ones down the list).
  const cut = oldest!
  return {
    orders: orders.filter(o => o.date > cut),
    complete,
    from: addDays(cut, 1),
    until: opts.until || null,
    nextPage: page - 1,
    nextUntil: cut,
  }
}

export function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

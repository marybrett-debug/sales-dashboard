import { NextRequest, NextResponse } from 'next/server'
import { parseOrder, isLiveOrder, ORDER_COLUMNS, AdminError } from '@/lib/admin'
import { ensureTables, defaultSince, applyOrders, logFailure, emailForKey } from '@/lib/sales-sync'

/*
 * Receives orders from the "BF Sales Sync" bookmarklet running on a signed-in admin page.
 * Authorised by the per-user bookmarklet key, not a dashboard session (the admin page has none).
 *
 * GET  ?key=…  → the date the bookmarklet should offer as its start date
 * POST         → { key, since, keys, rows } as text/plain (a fetch, or a form post fallback)
 */

export const maxDuration = 60

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
const FIELDS = Object.keys(ORDER_COLUMNS)

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: NextRequest) {
  await ensureTables()
  const email = await emailForKey(req.nextUrl.searchParams.get('key') || '')
  if (!email) return NextResponse.json({ error: 'This bookmarklet is out of date. Drag a new one from the sales dashboard.' }, { status: 401, headers: CORS })
  return NextResponse.json({ since: await defaultSince() }, { headers: CORS })
}

function page(req: NextRequest, ok: boolean, text: string) {
  const esc = text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BF Sales Sync</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1f2937">
<h2 style="color:${ok ? '#15803d' : '#b91c1c'}">${ok ? 'Sales dashboard synced' : 'Sales sync failed'}</h2><p>${esc}</p>
<p><a href="${req.nextUrl.origin}/">Open the sales dashboard</a> · <a href="javascript:history.back()">Back to the admin</a></p></body>`
  return new NextResponse(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export async function POST(req: NextRequest) {
  let body: { key?: string; since?: string; keys?: string[]; rows?: string[][]; x?: string }
  try { body = JSON.parse(await req.text()) } catch { return NextResponse.json({ error: 'The sync data was cut off or unreadable.' }, { status: 400, headers: CORS }) }
  const viaForm = body.x !== undefined
  const respond = (ok: boolean, json: Record<string, unknown>, status: number) =>
    viaForm ? page(req, ok, String(json.message || json.error)) : NextResponse.json(json, { status, headers: CORS })

  await ensureTables()
  const email = await emailForKey(body.key || '')
  if (!email) return respond(false, { error: 'This bookmarklet is out of date. Drag a new one from the sales dashboard.' }, 401)
  const since = /^\d{4}-\d{2}-\d{2}$/.test(body.since || '') ? body.since! : null
  if (!since) return respond(false, { error: 'Missing start date.' }, 400)
  const by = `${email} (bookmarklet)`

  try {
    const rows = body.rows || []
    const parsed = rows.map(r => parseOrder(Object.fromEntries(FIELDS.map((f, i) => [f, r[i]]))))
    if (rows.length > 0 && !parsed[0]) {
      throw new AdminError(`The orders grid has columns this sync doesn't recognise: ${(body.keys || []).join(', ')}`)
    }
    const orders = parsed.filter((o): o is NonNullable<typeof o> => !!o)
    if (orders.length > 1 && orders[0].date < orders[orders.length - 1].date) {
      throw new AdminError('The orders grid did not come back newest first, so nothing was changed.')
    }
    const today = new Date().toISOString().slice(0, 10)
    const to = orders[0] && orders[0].date > today ? orders[0].date : today
    const saved = await applyOrders(orders.filter(o => o.date >= since && isLiveOrder(o)), since, to, by, true, null)
    return respond(true, { ok: true, ...saved }, 200)
  } catch (e) {
    const message = e instanceof AdminError ? e.message : `Saving failed: ${(e as Error).message}`
    console.error('[admin-sync/push]', message)
    await logFailure(by, since, null, message)
    return respond(false, { error: message }, e instanceof AdminError ? 422 : 500)
  }
}

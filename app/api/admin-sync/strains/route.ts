import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { ensureTables, saveStrains, logFailure, emailForKey } from '@/lib/sales-sync'

/*
 * Receives a year's products report export (Item, Sold, Subtotal) from the BF Sales Sync bookmarklet
 * and replaces that channel's strain sales for the year.
 * POST { key, channel: 'retail' | 'wholesale', year, xlsx: base64 } as text/plain
 */

export const maxDuration = 60

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: NextRequest) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: CORS })
  let body: { key?: string; channel?: string; year?: number; xlsx?: string }
  try { body = JSON.parse(await req.text()) } catch { return fail('The strain data was cut off or unreadable.', 400) }

  await ensureTables()
  const email = await emailForKey(body.key || '')
  if (!email) return fail('This bookmarklet is out of date. Drag a new one from the sales dashboard.', 401)
  const channel = body.channel === 'wholesale' ? 'wholesale' : body.channel === 'retail' ? 'retail' : null
  const year = Number(body.year)
  if (!channel || !(year >= 2020 && year <= 2100) || !body.xlsx) return fail('Missing channel, year or report.', 400)
  const by = `${email} (bookmarklet)`

  try {
    const wb = XLSX.read(Buffer.from(body.xlsx, 'base64'), { type: 'buffer' })
    const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
    const head = (raw[0] || []).map(h => String(h).trim().toLowerCase())
    const iItem = head.indexOf('item'), iSold = head.indexOf('sold'), iSub = head.indexOf('subtotal')
    if (iItem < 0 || iSold < 0 || iSub < 0) {
      throw new Error(`The ${channel} products report has columns this sync doesn't recognise: ${(raw[0] || []).join(', ')}`)
    }
    const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0 }
    const rows = raw.slice(1)
      .map(r => ({ item: String(r[iItem] ?? '').trim(), sold: num(r[iSold]), subtotal: num(r[iSub]) }))
      .filter(r => r.item && !/^totals?$/i.test(r.item))
    if (rows.length === 0) throw new Error(`The ${channel} products report for ${year} came back empty, so nothing was changed.`)
    const saved = await saveStrains(rows, channel, year, by)
    return NextResponse.json({ ok: true, ...saved }, { headers: CORS })
  } catch (e) {
    const message = (e as Error).message
    console.error('[admin-sync/strains]', message)
    await logFailure(by, `${year}-01-01`, `${year}-12-31`, message)
    return fail(message, 422)
  }
}

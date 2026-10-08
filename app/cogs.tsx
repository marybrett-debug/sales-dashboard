'use client'

import { useState, useEffect, useMemo } from 'react'

/* ── COGS model for USA seed packs ───────────────────────────
 * Same formulas as barneys_farm_usa_cogs.xlsx: per-pack costs plus a share of
 * per-order costs (net shipping, inserts, merch, chargeback fee) spread over
 * packs per order, a replacement allowance, 2.5% processing on price, and the
 * cost of free packs carried by each paid pack.
 */

interface PackSize { n: number; sold: number; price: number; free: number }

export interface CogsInputs {
  seedAuto: number; seedFem: number; seedF1: number
  laborRate: number; laborHours: number; packsPerDay: number
  invoiceEur: number; invoicePacks: number; fx: number; otherPack: number
  envelope: number; card: number; catalog: number; catalogFreq: number; sticker: number; stickerFreq: number; merch: number
  postageSource: 'shipdash' | 'manual'; postageMonths: number
  postage: number; charged: number; packsPerOrder: number; paidPerOrder: number; freePerOrder: number
  procPct: number; procFixed: number; replPct: number
  sizes: PackSize[]
}

export const DEFAULT_COGS: CogsInputs = {
  seedAuto: 0.17, seedFem: 0.17, seedF1: 0.42,
  laborRate: 25, laborHours: 8, packsPerDay: 550,
  invoiceEur: 21428.98, invoicePacks: 68500, fx: 1.17, otherPack: 0,
  envelope: 0.02, card: 0.35, catalog: 0.5, catalogFreq: 0.93, sticker: 0.02, stickerFreq: 0.76, merch: 1.5,
  postageSource: 'shipdash', postageMonths: 6,
  postage: 8.11, charged: 1.93, packsPerOrder: 4.1, paidPerOrder: 3.2, freePerOrder: 0.9,
  procPct: 2.5, procFixed: 0.15, replPct: 3,
  sizes: [
    { n: 1, sold: 10708, price: 13.79, free: 420 },
    { n: 3, sold: 15019, price: 35.19, free: 210 },
    { n: 5, sold: 8826, price: 45.72, free: 167 },
    { n: 10, sold: 5826, price: 83.58, free: 114 },
    { n: 25, sold: 242, price: 182.14, free: 3 },
  ],
}

type SeedType = 'Auto' | 'Fem' | 'F1 Fem'
type NumKey = { [K in keyof CogsInputs]: CogsInputs[K] extends number ? K : never }[keyof CogsInputs]
interface MonthPostage { month: string; labels: number; postage: number; avg: number; priorityShare: number }

const PLACEHOLDERS: Partial<Record<NumKey, true>> = { merch: true }

const GROUPS: { title: string; fields: [NumKey, string, string][] }[] = [
  { title: 'Seeds', fields: [['seedAuto', 'Auto seed', '$ per seed'], ['seedFem', 'Feminized seed', '$ per seed'], ['seedF1', 'F1 Fem seed', '$ per seed']] },
  { title: 'Packing labor', fields: [['laborRate', 'Hourly rate', '$ per hour'], ['laborHours', 'Hours per day', 'hours'], ['packsPerDay', 'Packs per person per day', 'packs']] },
  { title: 'Packaging', fields: [['invoiceEur', 'Invoice 2026.04 total', 'EUR, incl. freight'], ['invoicePacks', 'Packs covered', 'cardboards on invoice'], ['fx', 'EUR to USD rate', 'USD per EUR'], ['otherPack', 'Other packaging per pack', '$']] },
  { title: 'In every order', fields: [['envelope', 'Envelope', '$ each'], ['card', 'Thank-you card', '$ each'], ['catalog', 'Catalog', '$ each'], ['catalogFreq', 'Catalogs per order', 'units'], ['sticker', 'Sticker', '$ each'], ['stickerFreq', 'Stickers per order', 'units'], ['merch', 'Free merch per order', '$']] },
  { title: 'Orders', fields: [['charged', 'Shipping charged per order', '$'], ['packsPerOrder', 'Packs per order', 'incl. free'], ['paidPerOrder', 'Paid packs per order', 'packs'], ['freePerOrder', 'Free packs per order', 'packs']] },
  { title: 'Fees and losses', fields: [['procPct', 'Payment processing', '% of price'], ['procFixed', 'Chargeback fee', '$ per order'], ['replPct', 'Replacements', '% of packs']] },
]

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/** Average postage per label over the last `n` complete months (the current month is skipped). */
function shipdashPostage(months: MonthPostage[], n: number) {
  const thisMonth = new Date().toISOString().slice(0, 7)
  const full = months.filter(m => m.month < thisMonth).slice(-Math.max(1, n))
  const labels = full.reduce((a, m) => a + m.labels, 0)
  if (!labels) return null
  return { avg: full.reduce((a, m) => a + m.postage, 0) / labels, labels, from: full[0].month, to: full[full.length - 1].month }
}

export function computeCogs(S: CogsInputs, type: SeedType, postage: number) {
  const seed = type === 'Auto' ? S.seedAuto : type === 'F1 Fem' ? S.seedF1 : S.seedFem
  const labor = (S.laborRate * S.laborHours) / S.packsPerDay
  const pkg = (S.invoiceEur / S.invoicePacks) * S.fx + S.otherPack
  const inserts = S.envelope + S.card + S.catalog * S.catalogFreq + S.sticker * S.stickerFreq + S.merch
  const netShip = postage - S.charged
  const alloc = (inserts + netShip) / S.packsPerOrder
  const fixed = S.procFixed / S.packsPerOrder
  const r = S.replPct / 100
  const p = S.procPct / 100
  const base = (n: number) => (n * seed + pkg + labor + alloc + fixed) * (1 + r)
  const freeTotal = S.sizes.reduce((a, s) => a + s.free, 0)
  const freePackCost = freeTotal ? S.sizes.reduce((a, s) => a + s.free * base(s.n), 0) / freeTotal : 0
  const carry = S.paidPerOrder ? (S.freePerOrder / S.paidPerOrder) * freePackCost : 0

  const rows = S.sizes.map(s => {
    const parts = {
      seed: s.n * seed, pkg, labor, ship: alloc, fees: fixed + s.price * p,
      repl: (s.n * seed + pkg + labor + alloc + fixed) * r, free: carry,
    }
    const cogs = base(s.n) + s.price * p + carry
    return { size: s, parts, cogs, margin: s.price ? (s.price - cogs) / s.price : 0 }
  })
  const sold = S.sizes.reduce((a, s) => a + s.sold, 0)
  const weighted = (f: (x: (typeof rows)[number]) => number) => (sold ? rows.reduce((a, x) => a + x.size.sold * f(x), 0) / sold : 0)
  const revenue = rows.reduce((a, x) => a + x.size.sold * x.size.price, 0)
  const profit = rows.reduce((a, x) => a + x.size.sold * (x.size.price - x.cogs), 0)
  return {
    rows, sold, netShip, inserts,
    avgCogs: weighted(x => x.cogs),
    avgPrice: weighted(x => x.size.price),
    margin: revenue ? profit / revenue : 0,
    perOrder: inserts + netShip + S.procFixed,
  }
}

export default function CogsDashboard({ token }: { token: string }) {
  const [saved, setSaved] = useState<CogsInputs>(DEFAULT_COGS)
  const [S, setS] = useState<CogsInputs>(DEFAULT_COGS)
  const [type, setType] = useState<SeedType>('Fem')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [months, setMonths] = useState<MonthPostage[]>([])
  const [shipError, setShipError] = useState('')

  useEffect(() => {
    const headers = { Authorization: `Bearer ${token}` }
    fetch('/api/cogs', { headers })
      .then(r => r.json())
      .then(d => {
        if (d.inputs) {
          const merged = { ...DEFAULT_COGS, ...d.inputs } as CogsInputs
          setSaved(merged); setS(merged)
          if (d.updatedBy) setStatus(`Last saved by ${d.updatedBy} on ${new Date(d.updatedAt).toLocaleDateString()}`)
        }
      })
      .catch(() => setStatus('Could not load saved numbers. Showing defaults.'))
      .finally(() => setLoading(false))
    fetch('/api/cogs/postage', { headers })
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'ShipDash is unavailable.')
        setMonths(d.months || [])
      })
      .catch(e => setShipError((e as Error).message))
  }, [token])

  const live = useMemo(() => shipdashPostage(months, S.postageMonths), [months, S.postageMonths])
  const useLive = S.postageSource === 'shipdash' && live !== null
  const postage = useLive ? live!.avg : S.postage
  const c = useMemo(() => computeCogs(S, type, postage), [S, type, postage])
  const dirty = JSON.stringify(S) !== JSON.stringify(saved)

  const setNum = (k: NumKey, v: string) => {
    const n = parseFloat(v)
    if (isFinite(n)) setS(prev => ({ ...prev, [k]: n }))
  }
  const setPrice = (i: number, v: string) => {
    const n = parseFloat(v)
    if (isFinite(n)) setS(prev => ({ ...prev, sizes: prev.sizes.map((s, j) => (j === i ? { ...s, price: n } : s)) }))
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/cogs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inputs: S }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed')
      setSaved(S)
      setStatus('Saved')
    } catch (e) {
      setStatus(`Could not save: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="card text-sm text-gray-500">Loading COGS model…</div>

  const breakdown: [keyof (typeof c.rows)[number]['parts'], string][] = [
    ['seed', 'Seeds'], ['pkg', 'Packaging'], ['labor', 'Labor'], ['ship', 'Shipping & inserts'],
    ['fees', 'Fees'], ['repl', 'Replace'], ['free', 'Free packs'],
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">COGS per Pack (USA)</h1>
          <p className="text-sm text-gray-500 mt-1">Change any number and the results update. Save to keep them for everyone.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs ${dirty ? 'text-amber-600' : 'text-gray-400'}`}>{dirty ? 'Unsaved changes' : status}</span>
          <button className="btn-secondary" disabled={!dirty} onClick={() => setS(saved)}>Undo changes</button>
          <button className="btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save numbers'}</button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card bg-brand-50 border-brand-100">
          <div className="text-xs uppercase tracking-wide text-gray-500">Avg COGS per paid pack · {type}</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{money(c.avgCogs)}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-gray-500">Avg selling price</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{money(c.avgPrice)}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-gray-500">Gross margin</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{pct(c.margin)}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-gray-500">Net shipping per order</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{money(c.netShip)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
        <div className="card space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold uppercase tracking-wider text-brand-700 mb-1">Postage</legend>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {(['shipdash', 'manual'] as const).map(src => (
                <button key={src} type="button" onClick={() => setS(p => ({ ...p, postageSource: src }))}
                  className={`flex-1 px-3 py-1.5 ${S.postageSource === src ? 'bg-brand-600 text-white' : 'bg-white text-gray-600'}`}>
                  {src === 'shipdash' ? 'From ShipDash' : 'Enter manually'}
                </button>
              ))}
            </div>
            {S.postageSource === 'shipdash' ? (
              live ? (
                <>
                  <NumRow id="postageMonths" label="Months to average" unit="last full months" value={S.postageMonths} onChange={v => setNum('postageMonths', v)} />
                  <p className="text-xs text-gray-500">
                    {money(live.avg)} per label across {live.labels.toLocaleString()} labels, {live.from} to {live.to}.
                  </p>
                </>
              ) : (
                <p className="text-xs text-amber-700">{shipError || 'Loading ShipDash…'} Using the manual figure ({money(S.postage)}) until it connects.</p>
              )
            ) : (
              <NumRow id="postage" label="Postage paid per order" unit="$" value={S.postage} onChange={v => setNum('postage', v)} />
            )}
          </fieldset>

          {GROUPS.map(g => (
            <fieldset key={g.title} className="space-y-2">
              <legend className="text-xs font-bold uppercase tracking-wider text-brand-700 mb-1">{g.title}</legend>
              {g.fields.map(([k, label, unit]) => (
                <NumRow key={k} id={k} label={label} unit={unit} value={S[k]} placeholder={!!PLACEHOLDERS[k]} onChange={v => setNum(k, v)} />
              ))}
            </fieldset>
          ))}

          <fieldset className="space-y-2">
            <legend className="text-xs font-bold uppercase tracking-wider text-brand-700 mb-1">Average selling price</legend>
            {S.sizes.map((s, i) => (
              <NumRow key={s.n} id={`price-${s.n}`} label={`${s.n}-seed pack`} unit={`${s.sold.toLocaleString()} paid packs sold`} value={s.price} onChange={v => setPrice(i, v)} />
            ))}
          </fieldset>
        </div>

        <div className="space-y-5 min-w-0">
          <div className="card">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 className="font-semibold text-gray-900">COGS per paid pack</h2>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {(['Auto', 'Fem', 'F1 Fem'] as SeedType[]).map(t => (
                  <button key={t} type="button" onClick={() => setType(t)}
                    className={`px-3 py-1.5 ${type === t ? 'bg-brand-600 text-white' : 'bg-white text-gray-600'}`}>{t}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-xs uppercase text-gray-500 border-b">
                    <th className="text-left py-2 pr-3">Pack</th>
                    <th className="text-right px-2">Share sold</th>
                    {breakdown.map(([, label]) => <th key={label} className="text-right px-2 whitespace-nowrap">{label}</th>)}
                    <th className="text-right px-2">COGS</th>
                    <th className="text-right px-2">Avg price</th>
                    <th className="text-right pl-2">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map(x => (
                    <tr key={x.size.n} className="border-b border-gray-100">
                      <td className="py-2 pr-3 whitespace-nowrap">{x.size.n}-seed</td>
                      <td className="text-right px-2">{pct(c.sold ? x.size.sold / c.sold : 0)}</td>
                      {breakdown.map(([k]) => <td key={k} className="text-right px-2">{money(x.parts[k])}</td>)}
                      <td className="text-right px-2 font-semibold text-brand-700">{money(x.cogs)}</td>
                      <td className="text-right px-2">{money(x.size.price)}</td>
                      <td className="text-right pl-2">{pct(x.margin)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2 pr-3">Weighted average</td>
                    <td colSpan={breakdown.length + 1} />
                    <td className="text-right px-2 text-brand-700">{money(c.avgCogs)}</td>
                    <td className="text-right px-2">{money(c.avgPrice)}</td>
                    <td className="text-right pl-2">{pct(c.margin)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Each paid pack carries its share of the free packs in the same order, plus processing on its selling price.
              Weighted by paid packs sold, Apr 1 to Oct 7, 2026. Free merch is a placeholder until supplier costs come in.
            </p>
          </div>

          <div className="card">
            <h2 className="font-semibold text-gray-900 mb-3">Per order</h2>
            <table className="w-full text-sm tabular-nums">
              <tbody>
                {([
                  [`Postage paid${useLive ? ' (ShipDash)' : ''}`, postage],
                  ['Shipping charged to customer', -S.charged],
                  ['Envelope, card, catalog, sticker', c.inserts - S.merch],
                  ['Free merch (placeholder)', S.merch],
                  ['Chargeback fee', S.procFixed],
                ] as [string, number][]).map(([label, v]) => (
                  <tr key={label} className="border-b border-gray-100"><td className="py-1.5">{label}</td><td className="text-right">{money(v)}</td></tr>
                ))}
                <tr className="font-semibold"><td className="py-1.5">Cost per order</td><td className="text-right text-brand-700">{money(c.perOrder)}</td></tr>
                <tr><td className="py-1.5 text-gray-500">Spread over {S.packsPerOrder} packs</td><td className="text-right text-gray-500">{money(c.perOrder / S.packsPerOrder)} per pack</td></tr>
              </tbody>
            </table>
          </div>

          {months.length > 0 && (
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-3">Postage by month (ShipDash)</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead>
                    <tr className="text-xs uppercase text-gray-500 border-b">
                      <th className="text-left py-2">Month</th><th className="text-right">Labels</th><th className="text-right">Postage</th>
                      <th className="text-right">Avg per label</th><th className="text-right">Priority share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...months].reverse().slice(0, 12).map(m => (
                      <tr key={m.month} className="border-b border-gray-100">
                        <td className="py-1.5">{m.month}</td><td className="text-right">{m.labels.toLocaleString()}</td>
                        <td className="text-right">{money(m.postage)}</td><td className="text-right">{money(m.avg)}</td>
                        <td className="text-right">{pct(m.priorityShare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NumRow({ id, label, unit, value, placeholder, onChange }: {
  id: string; label: string; unit: string; value: number; placeholder?: boolean; onChange: (v: string) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { if (parseFloat(text) !== value) setText(String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2 items-center">
      <label htmlFor={`cogs-${id}`} className="text-sm leading-tight">
        {label}
        {placeholder && <span className="ml-1 text-[10px] font-bold uppercase text-amber-600">placeholder</span>}
        <span className="block text-xs text-gray-400">{unit}</span>
      </label>
      <input
        id={`cogs-${id}`} type="number" step="any" inputMode="decimal" value={text}
        onChange={e => { setText(e.target.value); onChange(e.target.value) }}
        className={`w-full rounded-md border px-2 py-1 text-right text-sm tabular-nums ${placeholder ? 'border-amber-400 bg-amber-50' : 'border-gray-300 bg-white'}`}
      />
    </div>
  )
}

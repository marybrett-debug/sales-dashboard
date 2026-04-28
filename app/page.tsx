'use client'

import { useState, useEffect, useMemo, useCallback, Fragment, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import * as XLSX from 'xlsx'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

/* ── types ───────────────────────────────────────────────── */

interface OrderRow { date: Date; subtotal: number; total: number; tax: number; channel: 'retail' | 'wholesale' | 'bulk' | 'growers'; orderCount: number; clientName?: string }
interface StrainRow { item: string; strain: string; packSize: string; sold: number; subtotal: number; channel: 'retail' | 'wholesale' | 'bulk' | 'growers'; year: number }

interface YearData {
  year: number
  orders: OrderRow[]
  strains: StrainRow[]
  files: string[]
}

interface MonthRow { month: string; monthIdx: number; revenue: number; orders: number; avgOrder: number }

interface YearSummary {
  revenue: number; orders: number; avgOrder: number
  likeForLikeRevenue: number; likeForLikeOrders: number
  forecastRevenue: number; forecastOrders: number
  isPartialYear: boolean
  lastMonthWithData: number
}

interface DailyRow { day: number; label: string; revenue: number; orders: number; cumRevenue: number }

interface ChannelComputed {
  monthlyByYear: Map<number, MonthRow[]>
  yearTotals: Map<number, YearSummary>
  topStrainsByYear: Map<number, { strain: string; sold: number; revenue: number }[]>
  growthData: { month: string; actual: number; cumActual: number; monthlyTarget: number; cumTarget: number; gap: number; remaining: number }[]
  currentMonthDaily: DailyRow[]
  currentMonthLabel: string
  clientMonthlyData: Map<string, number[]>
}

type ViewMode = 'charts' | 'tables' | 'both'
type Region = 'usa' | 'europe'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const COLORS = ['#16a34a','#2563eb','#d97706','#dc2626','#7c3aed','#0891b2']

const REGION_CONFIG: Record<Region, { label: string; emoji: string; currency: (n: number) => string }> = {
  usa: {
    label: 'USA',
    emoji: '🇺🇸',
    currency: (n) => n >= 1000000 ? `$${(n / 1000000).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(0)}`,
  },
  europe: {
    label: 'Europe',
    emoji: '🇪🇺',
    currency: (n) => n >= 1000000 ? `€${(n / 1000000).toFixed(2)}M` : n >= 1000 ? `€${(n / 1000).toFixed(1)}K` : `€${n.toFixed(0)}`,
  },
}

/* ── helpers ─────────────────────────────────────────────── */

const toNum = (v: unknown) => {
  if (typeof v === 'number') return v
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''))
  return isNaN(n) ? 0 : n
}

const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

function parseDate(val: unknown): Date | null {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.getFullYear() >= 2020 && val.getFullYear() <= 2030 ? val : null
  }
  const s = String(val).trim()
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (dmy) {
    const d = new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]))
    return d.getFullYear() >= 2020 && d.getFullYear() <= 2030 ? d : null
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    const d = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]))
    return d.getFullYear() >= 2020 && d.getFullYear() <= 2030 ? d : null
  }
  if (/^\d{5}$/.test(s)) {
    const d = new Date((parseInt(s) - 25569) * 86400000)
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2020 && d.getFullYear() <= 2030) return d
  }
  return null
}

function parseStrain(item: string): { strain: string; packSize: string } {
  const m = item.match(/^(.+?)\s*[-–—]\s*(\d+)\s*[Ss]eeds?/)
  if (m) return { strain: m[1].trim(), packSize: m[2] }
  return { strain: item, packSize: '' }
}

function detectFileType(headers: string[]): 'orders' | 'seeds' | 'daily' | 'basic_orders' | null {
  const lower = headers.map(h => h.toLowerCase())
  if (lower.includes('order id') && lower.includes('date')) return 'orders'
  if (lower.includes('order id') && lower.includes('subtotal') && !lower.includes('date')) return 'basic_orders'
  if (lower.includes('item') && lower.includes('sold')) return 'seeds'
  if (lower.includes('date') && lower.includes('sales') && lower.some(h => h.includes('net total') || h.includes('sub total'))) return 'daily'
  return null
}

function detectChannel(fileName: string): 'retail' | 'wholesale' | 'bulk' | 'growers' {
  if (fileName.toLowerCase().includes('wholesale')) return 'wholesale'
  if (fileName.toLowerCase().includes('bulk')) return 'bulk'
  if (fileName.toLowerCase().includes('grower')) return 'growers'
  return 'retail'
}

function detectYearFromFilename(fileName: string): number {
  const matches = fileName.match(/(\d{8})/g)
  if (matches) {
    for (const m of matches) {
      const y = parseInt(m.slice(4))
      if (y >= 2020 && y <= 2030) return y
    }
  }
  const standalone = fileName.match(/\b(20[2-3]\d)\b/)
  if (standalone) return parseInt(standalone[1])
  return new Date().getFullYear()
}

function computeChannelData(
  yearData: Map<number, YearData>, years: number[],
  channel: 'retail' | 'wholesale' | 'bulk' | 'growers', growthTarget: number,
): ChannelComputed {
  const monthlyByYear = new Map<number, MonthRow[]>()
  for (const [year, yd] of yearData) {
    const m = MONTHS.map((mo, i) => ({ month: mo, monthIdx: i, revenue: 0, orders: 0, avgOrder: 0 }))
    for (const order of yd.orders) {
      if (order.channel !== channel) continue
      const mi = order.date.getMonth()
      m[mi].revenue += order.subtotal
      m[mi].orders += order.orderCount || 1
    }
    m.forEach(r => { r.avgOrder = r.orders > 0 ? r.revenue / r.orders : 0 })
    monthlyByYear.set(year, m)
  }

  const latestYear = years.length > 0 ? years[years.length - 1] : null
  const latestMonthly = latestYear ? monthlyByYear.get(latestYear) : null
  let lastMonthWithData = 11
  if (latestMonthly) {
    for (let i = 11; i >= 0; i--) {
      if (latestMonthly[i].revenue > 0) { lastMonthWithData = i; break }
    }
  }

  const yearTotals = new Map<number, YearSummary>()
  for (const [year, m] of monthlyByYear) {
    const rev = m.reduce((s, r) => s + r.revenue, 0)
    const ord = m.reduce((s, r) => s + r.orders, 0)
    const l4lRev = m.slice(0, lastMonthWithData + 1).reduce((s, r) => s + r.revenue, 0)
    const l4lOrd = m.slice(0, lastMonthWithData + 1).reduce((s, r) => s + r.orders, 0)
    const isPartial = year === latestYear && lastMonthWithData < 11
    // Seasonal weights based on historical cyclical pattern:
    // Jan-Apr: strong (peak growing season planning)
    // May-Aug: sales reduce significantly (off-season)
    // Sep-Dec: sales pick up again (autumn/winter planning)
    const seasonalWeights = [
      0.11, 0.11, 0.10, 0.09,  // Jan-Apr: strong — 41%
      0.05, 0.04, 0.04, 0.05,  // May-Aug: slow — 18%
      0.08, 0.10, 0.12, 0.11,  // Sep-Dec: pickup — 41%
    ]
    const monthsWithData = lastMonthWithData + 1
    const weightOfDataMonths = seasonalWeights.slice(0, monthsWithData).reduce((a, b) => a + b, 0)
    const forecastRev = isPartial ? Math.round(rev / weightOfDataMonths) : rev
    const forecastOrd = isPartial ? Math.round(ord / weightOfDataMonths) : ord
    yearTotals.set(year, {
      revenue: rev, orders: ord, avgOrder: ord > 0 ? rev / ord : 0,
      likeForLikeRevenue: l4lRev, likeForLikeOrders: l4lOrd,
      forecastRevenue: forecastRev, forecastOrders: forecastOrd,
      isPartialYear: isPartial, lastMonthWithData,
    })
  }

  const topStrainsByYear = new Map<number, { strain: string; sold: number; revenue: number }[]>()
  for (const [year, yd] of yearData) {
    const agg = new Map<string, { sold: number; revenue: number }>()
    for (const s of yd.strains) {
      if (s.channel !== channel) continue
      const existing = agg.get(s.strain) || { sold: 0, revenue: 0 }
      existing.sold += s.sold; existing.revenue += s.subtotal
      agg.set(s.strain, existing)
    }
    topStrainsByYear.set(year, [...agg.entries()].map(([strain, d]) => ({ strain, ...d })).sort((a, b) => b.sold - a.sold))
  }

  let growthData: ChannelComputed['growthData'] = []
  if (years.length >= 2) {
    const currYear = years[years.length - 1]
    const prevYear = years[years.length - 2]
    const currMonthly = monthlyByYear.get(currYear)
    const prevMonthly = monthlyByYear.get(prevYear)
    if (currMonthly && prevMonthly) {
      const prevTotal = prevMonthly.reduce((s, m) => s + m.revenue, 0)
      const targetTotal = prevTotal * (1 + growthTarget / 100)
      // Distribute targets seasonally (same weights as forecast)
      const targetWeights = [0.11, 0.11, 0.10, 0.09, 0.05, 0.04, 0.04, 0.05, 0.08, 0.10, 0.12, 0.11]
      let cumActual = 0, cumTarget = 0
      growthData = MONTHS.map((month, idx) => {
        const monthlyTarget = targetTotal * targetWeights[idx]
        cumActual += currMonthly[idx].revenue; cumTarget += monthlyTarget
        return { month, actual: Math.round(currMonthly[idx].revenue), cumActual: Math.round(cumActual), monthlyTarget: Math.round(monthlyTarget), cumTarget: Math.round(cumTarget), gap: Math.round(cumActual - cumTarget), remaining: idx < 11 ? Math.round(Math.max(0, targetTotal - cumActual) / (11 - idx)) : 0 }
      })
    }
  }

  const now = new Date()
  const currMonth = now.getMonth(), currMonthYear = now.getFullYear()
  const currentMonthLabel = `${MONTHS[currMonth]} ${currMonthYear}`
  let currentMonthDaily: DailyRow[] = []
  const latestYd = yearData.get(currMonthYear)
  if (latestYd) {
    const daysInMonth = new Date(currMonthYear, currMonth + 1, 0).getDate()
    const dailyMap = new Map<number, { revenue: number; orders: number }>()
    for (let d = 1; d <= daysInMonth; d++) dailyMap.set(d, { revenue: 0, orders: 0 })
    for (const order of latestYd.orders) {
      if (order.channel !== channel || order.date.getMonth() !== currMonth || order.date.getFullYear() !== currMonthYear) continue
      const day = order.date.getDate()
      const entry = dailyMap.get(day)
      if (entry) { entry.revenue += order.subtotal; entry.orders += order.orderCount || 1 }
    }
    let cumRev = 0
    currentMonthDaily = Array.from(dailyMap.entries()).sort((a, b) => a[0] - b[0]).map(([day, d]) => {
      cumRev += d.revenue
      return { day, label: `${MONTHS[currMonth]} ${day}`, revenue: Math.round(d.revenue), orders: d.orders, cumRevenue: Math.round(cumRev) }
    })
  }

  // Client monthly data for wholesale/bulk
  const clientMonthlyData = new Map<string, number[]>()
  for (const [year, yd] of yearData) {
    for (const order of yd.orders) {
      if (order.channel !== channel || !order.clientName) continue
      if (!clientMonthlyData.has(order.clientName)) {
        clientMonthlyData.set(order.clientName, Array(12).fill(0))
      }
      const monthData = clientMonthlyData.get(order.clientName)!
      const month = order.date.getMonth()
      monthData[month] += order.subtotal
    }
  }

  return { monthlyByYear, yearTotals, topStrainsByYear, growthData, currentMonthDaily, currentMonthLabel, clientMonthlyData }
}

/* ── pure render: channel section ────────────────────────── */

function renderChannelSection(
  title: string, emoji: string, color: string,
  years: number[], data: ChannelComputed,
  viewMode: ViewMode, growthTarget: number, setGrowthTarget: (v: number) => void,
  fmtCurrency: (n: number) => string,
  isOpen: boolean, setIsOpen: (v: boolean) => void,
  strainYear: number | null, setStrainYear: (v: number | null) => void,
) {
  const { monthlyByYear, yearTotals, topStrainsByYear, growthData, currentMonthDaily, currentMonthLabel, clientMonthlyData } = data
  const hasOrders = [...yearTotals.values()].some(t => t.orders > 0)
  const hasStrains = [...topStrainsByYear.values()].some(s => s.length > 0)
  if (!hasOrders && !hasStrains) return null

  const chartData = MONTHS.map((month, idx) => {
    const row: Record<string, unknown> = { month }
    for (const [year, monthly] of monthlyByYear) row[`rev_${year}`] = Math.round(monthly[idx].revenue)
    return row
  })

  return (
    <div className="space-y-4">
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="cursor-pointer flex items-center gap-2 border-b-2 pb-2" style={{ borderColor: color }}
      >
        <span className="text-lg transition-transform" style={{ transform: isOpen ? 'rotate(90deg)' : '' }}>▶</span>
        <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
          <span>{emoji}</span> {title}
        </h2>
      </div>

      {!isOpen && <div className="h-0" />}
      {isOpen && (
        <>
          {/* Summary cards */}
      {hasOrders && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {years.map((year, i) => {
            const t = yearTotals.get(year)
            if (!t) return null
            const prev = i > 0 ? yearTotals.get(years[i - 1]) : null
            let yoyRev: number | null = null
            if (prev && t.isPartialYear && prev.likeForLikeRevenue > 0) {
              yoyRev = ((t.likeForLikeRevenue - prev.likeForLikeRevenue) / prev.likeForLikeRevenue * 100)
            } else if (prev && prev.revenue > 0) {
              yoyRev = ((t.revenue - prev.revenue) / prev.revenue * 100)
            }
            return (
              <div key={year} className="card border-l-4" style={{ borderLeftColor: COLORS[i % COLORS.length] }}>
                <p className="text-xs font-semibold text-gray-500">{year}{t.isPartialYear ? ` (Jan–${MONTHS[t.lastMonthWithData]})` : ''}</p>
                <p className="text-lg font-bold text-gray-900">{fmtCurrency(t.revenue)}</p>
                <p className="text-xs text-gray-500">{fmtNum(t.orders)} orders</p>
                {yoyRev !== null && (
                  <p className={`text-xs font-semibold mt-1 ${yoyRev >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {yoyRev >= 0 ? '↑' : '↓'} {Math.abs(yoyRev).toFixed(1)}% YoY{t.isPartialYear ? ' (like-for-like)' : ''}
                  </p>
                )}
                {t.isPartialYear && <p className="text-xs text-blue-600 font-semibold mt-0.5">Forecast: {fmtCurrency(t.forecastRevenue)}</p>}
              </div>
            )
          })}
        </div>
      )}

      {/* Current month daily */}
      {hasOrders && currentMonthDaily.length > 0 && currentMonthDaily.some(d => d.revenue > 0) && (viewMode === 'charts' || viewMode === 'both') && (
        <div className="card">
          <h3 className="font-semibold text-gray-700 mb-1 text-sm">Daily Sales — {currentMonthLabel}</h3>
          <p className="text-xs text-gray-400 mb-3">Revenue by day this month</p>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={currentMonthDaily.filter(d => d.day <= new Date().getDate())} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={fmtCurrency} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number, name: string) => [fmtCurrency(value), name === 'revenue' ? 'Revenue' : 'Cumulative']} labelFormatter={(day) => `${currentMonthLabel.split(' ')[0]} ${day}`} labelStyle={{ fontWeight: 600 }} />
                <Legend />
                <Bar dataKey="revenue" name="Daily Revenue" fill={color} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            {(() => {
              const withData = currentMonthDaily.filter(d => d.day <= new Date().getDate() && d.revenue > 0)
              const totalRev = withData.reduce((s, d) => s + d.revenue, 0)
              const totalOrd = withData.reduce((s, d) => s + d.orders, 0)
              const avgDaily = withData.length > 0 ? totalRev / withData.length : 0
              return (
                <>
                  <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">MTD Revenue</p><p className="text-sm font-bold">{fmtCurrency(totalRev)}</p></div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">MTD Orders</p><p className="text-sm font-bold">{fmtNum(totalOrd)}</p></div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">Avg/Day</p><p className="text-sm font-bold">{fmtCurrency(avgDaily)}</p></div>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* Revenue chart */}
      {hasOrders && (viewMode === 'charts' || viewMode === 'both') && (
        <div className="card">
          <h3 className="font-semibold text-gray-700 mb-3 text-sm">Monthly Revenue</h3>
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={fmtCurrency} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => fmtCurrency(value)} labelStyle={{ fontWeight: 600 }} />
                <Legend />
                {years.map((year, i) => (
                  <Bar key={year} dataKey={`rev_${year}`} name={String(year)} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Monthly table */}
      {hasOrders && (viewMode === 'tables' || viewMode === 'both') && (
        <div className="card overflow-x-auto">
          <h3 className="font-semibold text-gray-700 mb-3 text-sm">Monthly Breakdown</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2 text-left">Month</th>
                {years.map((y, i) => (
                  <Fragment key={y}>
                    <th className="py-2 text-right" style={{ color: COLORS[i % COLORS.length] }}>{y} Rev</th>
                    <th className="py-2 text-right text-gray-400">{y} Ord</th>
                  </Fragment>
                ))}
                {years.length >= 2 && <th className="py-2 text-right">YoY</th>}
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((month, mi) => {
                const vals = years.map(y => monthlyByYear.get(y)?.[mi])
                const last = vals[vals.length - 1]
                const prev = vals.length >= 2 ? vals[vals.length - 2] : null
                const latestSummary = yearTotals.get(years[years.length - 1])
                const isFutureMonth = latestSummary?.isPartialYear && mi > latestSummary.lastMonthWithData
                const currentMonth = new Date().getMonth()
                const isCompletedMonth = mi < currentMonth
                const yoy = isCompletedMonth && prev && prev.revenue > 0 && last && last.revenue > 0
                  ? ((last!.revenue - prev.revenue) / prev.revenue * 100) : null
                return (
                  <tr key={month} className={`border-b border-gray-50 hover:bg-gray-50 ${isFutureMonth ? 'opacity-40' : ''}`}>
                    <td className="py-2 font-medium text-gray-700">{month}</td>
                    {vals.map((v, i) => (
                      <Fragment key={`${years[i]}_${mi}`}>
                        <td className="py-2 text-right text-gray-800">{v && v.revenue > 0 ? fmtCurrency(v.revenue) : '—'}</td>
                        <td className="py-2 text-right text-gray-400">{v && v.orders > 0 ? fmtNum(v.orders) : '—'}</td>
                      </Fragment>
                    ))}
                    {years.length >= 2 && (
                      <td className={`py-2 text-right text-xs font-semibold ${yoy === null ? 'text-gray-300' : yoy >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {yoy !== null ? `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%` : '—'}
                      </td>
                    )}
                  </tr>
                )
              })}
              {/* Like-for-like row */}
              {(() => {
                const ls = yearTotals.get(years[years.length - 1])
                if (ls?.isPartialYear) {
                  return (
                    <tr className="border-t-2 border-gray-300 font-bold">
                      <td className="py-2">Like-for-like (Jan–{MONTHS[ls.lastMonthWithData]})</td>
                      {years.map(y => { const t = yearTotals.get(y); return (<Fragment key={y}><td className="py-2 text-right">{fmtCurrency(t?.likeForLikeRevenue ?? 0)}</td><td className="py-2 text-right text-gray-400">{fmtNum(t?.likeForLikeOrders ?? 0)}</td></Fragment>) })}
                      {years.length >= 2 && (() => { const last = yearTotals.get(years[years.length - 1]); const prev = yearTotals.get(years[years.length - 2]); const yoy = prev && prev.likeForLikeRevenue > 0 ? ((last!.likeForLikeRevenue - prev.likeForLikeRevenue) / prev.likeForLikeRevenue * 100) : null; return <td className={`py-2 text-right text-xs font-semibold ${yoy === null ? '' : yoy >= 0 ? 'text-green-600' : 'text-red-600'}`}>{yoy !== null ? `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%` : ''}</td> })()}
                    </tr>
                  )
                }
                return null
              })()}
              {/* Total row */}
              <tr className={`border-t-2 border-gray-300 font-bold`}>
                <td className="py-2">Total{yearTotals.get(years[years.length - 1])?.isPartialYear ? ' (YTD)' : ''}</td>
                {years.map(y => { const t = yearTotals.get(y); return (<Fragment key={y}><td className="py-2 text-right">{fmtCurrency(t?.revenue ?? 0)}</td><td className="py-2 text-right text-gray-400">{fmtNum(t?.orders ?? 0)}</td></Fragment>) })}
                {years.length >= 2 && (() => { const last = yearTotals.get(years[years.length - 1]); const prev = yearTotals.get(years[years.length - 2]); if (last?.isPartialYear) return <td className="py-2 text-right text-xs text-gray-400">—</td>; const yoy = prev && prev.revenue > 0 ? ((last!.revenue - prev!.revenue) / prev!.revenue * 100) : null; return <td className={`py-2 text-right text-xs font-semibold ${yoy === null ? '' : yoy >= 0 ? 'text-green-600' : 'text-red-600'}`}>{yoy !== null ? `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%` : ''}</td> })()}
              </tr>
              {/* Forecast row */}
              {(() => {
                const ls = yearTotals.get(years[years.length - 1])
                if (ls?.isPartialYear) {
                  return (
                    <tr className="font-bold text-blue-700 bg-blue-50/50">
                      <td className="py-2">Full Year Forecast</td>
                      {years.map(y => { const t = yearTotals.get(y); return (<Fragment key={y}><td className="py-2 text-right">{t?.isPartialYear ? fmtCurrency(t.forecastRevenue) : '—'}</td><td className="py-2 text-right text-blue-400">{t?.isPartialYear ? fmtNum(t.forecastOrders) : '—'}</td></Fragment>) })}
                      {years.length >= 2 && (() => { const last = yearTotals.get(years[years.length - 1]); const prev = yearTotals.get(years[years.length - 2]); const yoy = prev && prev.revenue > 0 && last ? ((last.forecastRevenue - prev.revenue) / prev.revenue * 100) : null; return <td className={`py-2 text-right text-xs font-semibold ${yoy === null ? '' : yoy >= 0 ? 'text-green-600' : 'text-red-600'}`}>{yoy !== null ? `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}% proj.` : ''}</td> })()}
                    </tr>
                  )
                }
                return null
              })()}
            </tbody>
          </table>
        </div>
      )}

      {/* Top strains */}
      {hasStrains && (() => {
        // Determine which years have strain data
        const strainYears = years.filter(y => (topStrainsByYear.get(y) ?? []).length > 0)
        if (strainYears.length === 0) return null
        const selectedYear = strainYear && strainYears.includes(strainYear) ? strainYear : strainYears[strainYears.length - 1]
        const allStrains = topStrainsByYear.get(selectedYear) ?? []
        const topStrains = allStrains.slice(0, 15)
        return (
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-700 text-sm">Top Strains by Units Sold</h3>
              {strainYears.length > 1 && (
                <select className="text-xs border rounded px-2 py-1 text-gray-600" value={selectedYear} onChange={e => setStrainYear(Number(e.target.value))}>
                  {strainYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-gray-400 uppercase">
                    <th className="py-2 text-left">Rank</th>
                    <th className="py-2 text-left">Strain</th>
                    <th className="py-2 text-right">Units</th>
                    <th className="py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {topStrains.map((s, rank) => (
                    <tr key={s.strain} className="border-b border-gray-50">
                      <td className="py-2 text-gray-400">{rank + 1}</td>
                      <td className="py-2 font-medium text-gray-700">{s.strain}</td>
                      <td className="py-2 text-right">{fmtNum(s.sold)}</td>
                      <td className="py-2 text-right text-gray-500">{fmtCurrency(s.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}

      {/* Least Strains Sold */}
      {hasStrains && (() => {
        const strainYears = years.filter(y => (topStrainsByYear.get(y) ?? []).length > 0)
        if (strainYears.length === 0) return null
        const selectedYear = strainYear && strainYears.includes(strainYear) ? strainYear : strainYears[strainYears.length - 1]
        const allStrains = topStrainsByYear.get(selectedYear) ?? []
        const leastStrains = [...allStrains].sort((a, b) => a.sold - b.sold).slice(0, 15)
        return leastStrains.length > 0 ? (
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-700 text-sm">Least Strains Sold ({selectedYear})</h3>
              {strainYears.length > 1 && (
                <select className="text-xs border rounded px-2 py-1 text-gray-600" value={selectedYear} onChange={e => setStrainYear(Number(e.target.value))}>
                  {strainYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-gray-400 uppercase">
                    <th className="py-2 text-left">Rank</th>
                    <th className="py-2 text-left">Strain</th>
                    <th className="py-2 text-right">Units</th>
                    <th className="py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {leastStrains.map((s, rank) => (
                    <tr key={s.strain} className="border-b border-gray-50">
                      <td className="py-2 text-gray-400">{rank + 1}</td>
                      <td className="py-2 font-medium text-gray-700">{s.strain}</td>
                      <td className="py-2 text-right">{fmtNum(s.sold)}</td>
                      <td className="py-2 text-right text-gray-500">{fmtCurrency(s.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null
      })()}

      {/* Wholesale clients monthly table */}
      {title === 'Wholesale' && clientMonthlyData.size > 0 && (
        <div className="card overflow-x-auto">
          <h3 className="font-semibold text-gray-700 mb-3 text-sm">Wholesale Sales per Client</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2 text-left">Client Name</th>
                {MONTHS.map(m => <th key={m} className="py-2 text-right">{m}</th>)}
                <th className="py-2 text-right font-semibold text-gray-700">Total</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(clientMonthlyData.entries()).sort((a, b) => {
                const aTotal = a[1].reduce((s, m) => s + m, 0)
                const bTotal = b[1].reduce((s, m) => s + m, 0)
                return bTotal - aTotal
              }).map(([clientName, monthlyRevenue]) => {
                const total = monthlyRevenue.reduce((s, m) => s + m, 0)
                return (
                  <tr key={clientName} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2 font-medium text-gray-700">{clientName}</td>
                    {monthlyRevenue.map((rev, mi) => (
                      <td key={mi} className="py-2 text-right text-gray-800">{rev > 0 ? fmtCurrency(rev) : '—'}</td>
                    ))}
                    <td className="py-2 text-right font-semibold text-gray-800">{fmtCurrency(total)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Growth trajectory */}
      {hasOrders && years.length >= 2 && growthData.length > 0 && (
        <div className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h3 className="font-semibold text-gray-700 text-sm">Growth Trajectory</h3>
            <div className="flex items-center gap-2 text-sm">
              <label className="text-gray-500">Target:</label>
              <input type="number" value={growthTarget} onChange={e => setGrowthTarget(Math.max(0, parseInt(e.target.value) || 0))} className="w-16 rounded border border-gray-300 px-2 py-1 text-center text-sm" />
              <span className="text-gray-500">% YoY</span>
            </div>
          </div>
          {(() => {
            const prevYear = years[years.length - 2], currYear = years[years.length - 1]
            const prevSummary = yearTotals.get(prevYear), currSummary = yearTotals.get(currYear)
            const prevTotal = prevSummary?.revenue ?? 0, currTotal = currSummary?.revenue ?? 0
            const targetTotal = prevTotal * (1 + growthTarget / 100)
            const isPartial = currSummary?.isPartialYear ?? false
            const forecastTotal = currSummary?.forecastRevenue ?? currTotal
            const gap = targetTotal - (isPartial ? forecastTotal : currTotal)
            return (
              <div className={`grid grid-cols-2 ${isPartial ? 'sm:grid-cols-5' : 'sm:grid-cols-4'} gap-3 mb-4`}>
                <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">{prevYear} Total</p><p className="text-sm font-bold">{fmtCurrency(prevTotal)}</p></div>
                <div className="rounded-lg bg-blue-50 px-3 py-2"><p className="text-xs text-blue-600">Target ({growthTarget}%)</p><p className="text-sm font-bold text-blue-700">{fmtCurrency(targetTotal)}</p></div>
                <div className="rounded-lg bg-green-50 px-3 py-2"><p className="text-xs text-green-600">{currYear} YTD{isPartial ? ` (Jan–${MONTHS[currSummary!.lastMonthWithData]})` : ''}</p><p className="text-sm font-bold text-green-700">{fmtCurrency(currTotal)}</p></div>
                {isPartial && <div className="rounded-lg bg-purple-50 px-3 py-2"><p className="text-xs text-purple-600">{currYear} Forecast</p><p className="text-sm font-bold text-purple-700">{fmtCurrency(forecastTotal)}</p></div>}
                <div className={`rounded-lg px-3 py-2 ${gap <= 0 ? 'bg-green-50' : 'bg-amber-50'}`}><p className="text-xs text-gray-600">{gap <= 0 ? 'Ahead by' : 'Gap to target'}{isPartial ? ' (vs forecast)' : ''}</p><p className={`text-sm font-bold ${gap <= 0 ? 'text-green-700' : 'text-amber-700'}`}>{fmtCurrency(Math.abs(gap))}</p></div>
              </div>
            )
          })()}
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={growthData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={fmtCurrency} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => fmtCurrency(value)} />
                <Legend />
                <Line type="monotone" dataKey="cumActual" name="Actual (cumulative)" stroke="#16a34a" strokeWidth={2.5} dot={{ fill: '#16a34a', r: 3 }} />
                <Line type="monotone" dataKey="cumTarget" name={`Target (${growthTarget}%)`} stroke="#2563eb" strokeWidth={2} strokeDasharray="6 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  )
}

/* ── auth gate ───────────────────────────────────────────── */

function LoginGate() {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setSending(true); setError('')
    try {
      const res = await fetch('/api/auth/send-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim().toLowerCase() }) })
      const data = await res.json()
      if (!res.ok) setError(data.error || 'Failed to send link')
      else setSent(true)
    } catch { setError('Network error — please try again') }
    finally { setSending(false) }
  }

  if (sent) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="card max-w-sm w-full text-center space-y-4">
          <div className="text-4xl">📧</div>
          <h2 className="text-lg font-bold text-gray-900">Check your email</h2>
          <p className="text-sm text-gray-600">If <span className="font-semibold">{email}</span> is authorised, we&apos;ve sent a login link.</p>
          <p className="text-xs text-gray-400">The link expires in 15 minutes.</p>
          <button onClick={() => { setSent(false); setEmail('') }} className="text-xs text-brand-600 underline">Try a different email</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="card max-w-sm w-full space-y-4">
        <div className="text-center">
          <h2 className="text-lg font-bold text-gray-900">Sales Dashboard</h2>
          <p className="text-sm text-gray-500 mt-1">Enter your email to receive a login link.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input type="email" placeholder="you@barneysfarm.com" value={email} onChange={e => setEmail(e.target.value)} className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none" autoFocus />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button type="submit" disabled={sending || !email.trim()} className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{sending ? 'Sending…' : 'Send Login Link'}</button>
        </form>
        <p className="text-xs text-gray-400 text-center">Only authorised Barney&apos;s Farm emails can access this dashboard.</p>
      </div>
    </div>
  )
}

/* ── spinner ─────────────────────────────────────────────── */

function Spinner({ text }: { text: string }) {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {text}
      </div>
    </div>
  )
}

/* ── main page wrapper ───────────────────────────────────── */

export default function Page() {
  return (
    <Suspense fallback={<Spinner text="Loading…" />}>
      <AuthGate />
    </Suspense>
  )
}

function AuthGate() {
  const searchParams = useSearchParams()
  const [authState, setAuthState] = useState<'loading' | 'logged-in' | 'logged-out'>('loading')
  const [authEmail, setAuthEmail] = useState('')

  useEffect(() => {
    const checkAuth = async () => {
      const token = searchParams.get('token')
      if (token) {
        try {
          const res = await fetch('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
          const data = await res.json()
          if (res.ok && data.session) {
            localStorage.setItem('dashboard_session', data.session)
            localStorage.setItem('dashboard_email', data.email)
            setAuthEmail(data.email); setAuthState('logged-in')
            window.history.replaceState({}, '', '/')
            return
          }
        } catch { /* fall through */ }
      }
      const session = localStorage.getItem('dashboard_session')
      if (session) {
        try {
          const res = await fetch('/api/auth/verify', { method: 'GET', headers: { Authorization: `Bearer ${session}` } })
          const data = await res.json()
          if (res.ok && data.authenticated) { setAuthEmail(data.email); setAuthState('logged-in'); return }
        } catch { /* fall through */ }
        localStorage.removeItem('dashboard_session'); localStorage.removeItem('dashboard_email')
      }
      setAuthState('logged-out')
    }
    checkAuth()
  }, [searchParams])

  const handleLogout = () => {
    localStorage.removeItem('dashboard_session'); localStorage.removeItem('dashboard_email')
    setAuthState('logged-out'); setAuthEmail('')
  }

  if (authState === 'loading') return <Spinner text="Checking access…" />
  if (authState === 'logged-out') return <LoginGate />
  return <DashboardWithTabs email={authEmail} onLogout={handleLogout} />
}

/* ── dashboard with region tabs ──────────────────────────── */

function DashboardWithTabs({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [region, setRegion] = useState<Region>('usa')

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Barney&apos;s Farm — Sales Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Multi-region sales comparison and forecasting</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">{email}</span>
          <button onClick={onLogout} className="text-xs text-gray-500 hover:text-red-600 underline">Logout</button>
        </div>
      </div>

      {/* Region tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6">
          {(Object.keys(REGION_CONFIG) as Region[]).map(r => (
            <button
              key={r}
              onClick={() => setRegion(r)}
              className={`pb-3 px-1 text-sm font-medium transition-colors ${region === r ? 'tab-active' : 'tab-inactive'}`}
            >
              {REGION_CONFIG[r].emoji} {REGION_CONFIG[r].label}
            </button>
          ))}
        </nav>
      </div>

      {/* Region content */}
      <RegionDashboard key={region} region={region} />
    </div>
  )
}

/* ── region dashboard (loads data per region) ────────────── */

function RegionDashboard({ region }: { region: Region }) {
  const [yearData, setYearData] = useState<Map<number, YearData>>(new Map())
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string>('')
  const [loadingData, setLoadingData] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('both')
  const [retailGrowth, setRetailGrowth] = useState(20)
  const [wholesaleGrowth, setWholesaleGrowth] = useState(20)
  const [bulkGrowth, setBulkGrowth] = useState(20)
  const [growersGrowth, setGrowersGrowth] = useState(20)
  const [retailOpen, setRetailOpen] = useState(true)
  const [wholesaleOpen, setWholesaleOpen] = useState(true)
  const [bulkOpen, setBulkOpen] = useState(true)
  const [growersOpen, setGrowersOpen] = useState(true)
  const [retailStrainYear, setRetailStrainYear] = useState<number | null>(null)
  const [wholesaleStrainYear, setWholesaleStrainYear] = useState<number | null>(null)
  const [bulkStrainYear, setBulkStrainYear] = useState<number | null>(null)
  const [growersStrainYear, setGrowersStrainYear] = useState<number | null>(null)

  const years = useMemo(() => [...yearData.keys()].sort(), [yearData])
  const fmtCurrency = REGION_CONFIG[region].currency
  const getSessionToken = () => localStorage.getItem('dashboard_session') || ''

  /* ── load saved data from server ────────────────────────── */
  const loadFromServer = useCallback(async () => {
    setLoadingData(true)
    try {
      const res = await fetch(`/api/dashboard?region=${region}`, { headers: { Authorization: `Bearer ${getSessionToken()}` } })
      if (!res.ok) { setLoadingData(false); return }
      const data = await res.json()
      if (!data.files || data.files.length === 0) { setYearData(new Map()); setLoadingData(false); return }

      const updated = new Map<number, YearData>()
      const getYd = (y: number) => { if (!updated.has(y)) updated.set(y, { year: y, orders: [], strains: [], files: [] }); return updated.get(y)! }

      for (const o of data.orders) {
        const date = new Date(o.order_date)
        if (isNaN(date.getTime())) continue
        const y = date.getFullYear(), yd = getYd(y), fname = o.filename as string
        if (!yd.files.includes(fname)) yd.files.push(fname)
        yd.orders.push({ date, subtotal: Number(o.subtotal), total: Number(o.total), tax: Number(o.tax), channel: o.channel as 'retail' | 'wholesale' | 'bulk', orderCount: Number(o.order_count) || 1, clientName: String(o.client_name || '') })
      }

      for (const s of data.strains) {
        const y = Number(s.year), yd = getYd(y), fname = s.filename as string
        if (!yd.files.includes(fname)) yd.files.push(fname)
        yd.strains.push({ item: s.item, strain: s.strain, packSize: s.pack_size, sold: Number(s.sold), subtotal: Number(s.subtotal), channel: s.channel as 'retail' | 'wholesale' | 'bulk', year: y })
      }

      setYearData(updated)
    } catch (e) { console.error('Failed to load saved data:', e) }
    finally { setLoadingData(false) }
  }, [region])

  useEffect(() => { loadFromServer() }, [loadFromServer])

  /* ── save to server ────────────────────────────────────── */
  const [lastError, setLastError] = useState('')
  const saveFileToServer = useCallback(async (filename: string, channel: 'retail' | 'wholesale' | 'bulk' | 'growers', fileType: 'orders' | 'seeds' | 'daily', orders: OrderRow[], strains: StrainRow[]): Promise<boolean> => {
    try {
      const body = JSON.stringify({
        filename, region, channel, fileType,
        orders: orders.map(o => ({ date: o.date.toISOString().slice(0, 10), subtotal: o.subtotal, total: o.total, tax: o.tax, channel: o.channel, isCountOnly: false, orderCount: o.orderCount || 1, clientName: o.clientName || null })),
        strains: strains.map(s => ({ item: s.item, strain: s.strain, packSize: s.packSize, sold: s.sold, subtotal: s.subtotal, channel: s.channel, year: s.year })),
      })
      const res = await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSessionToken()}` },
        body,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        const msg = `${filename}: ${res.status} — ${err.error || JSON.stringify(err)}`
        console.error('Save failed:', msg)
        setLastError(msg)
        return false
      }
      return true
    } catch (e) {
      const msg = `${filename}: ${e instanceof Error ? e.message : String(e)}`
      console.error('Failed to save:', msg)
      setLastError(msg)
      return false
    }
  }, [region])

  /* ── clear data ────────────────────────────────────────── */
  const clearAllData = useCallback(async () => {
    setYearData(new Map())
    try { await fetch(`/api/dashboard?region=${region}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getSessionToken()}` } }) }
    catch (e) { console.error('Failed to clear:', e) }
  }, [region])

  /* ── file upload ───────────────────────────────────────── */
  const handleFiles = useCallback(async (files: FileList) => {
    setUploading(true)
    setUploadStatus('')
    let successCount = 0, failCount = 0, skippedFiles: string[] = []

    for (const file of Array.from(files)) {
      if (!file.name.match(/\.(xlsx?|csv|tsv|pdf)$/i)) continue

      // Handle PDF files separately
      if (file.name.match(/\.pdf$/i)) {
        try {
          setUploadStatus(`Processing ${file.name}...`)
          const formData = new FormData()
          formData.append('file', file)
          const res = await fetch('/api/parse-invoice', { method: 'POST', body: formData })
          if (!res.ok) {
            failCount++
            skippedFiles.push(`${file.name} (parse error: ${res.status})`)
            continue
          }
          const data = await res.json()
          if (!data.invoice) {
            failCount++
            skippedFiles.push(`${file.name} (no invoice data)`)
            continue
          }
          const invoice = data.invoice
          // WS-format invoices → growers channel; Sun Drops → bulk channel
          const pdfChannel: 'bulk' | 'growers' = data.format === 'ws' ? 'growers' : 'bulk'
          const fileOrders: OrderRow[] = []
          const fileStrains: StrainRow[] = []

          // Create order row from invoice total
          let invoiceDate: Date
          if (invoice.date) {
            const parsed = parseDate(invoice.date)
            invoiceDate = parsed || new Date(parseInt(invoice.invoiceNumber.split('-')[0]), 0, 1)
          } else {
            invoiceDate = new Date(parseInt(invoice.invoiceNumber.split('-')[0]), 0, 1)
          }

          fileOrders.push({
            date: invoiceDate,
            subtotal: invoice.subtotal,
            total: invoice.total,
            tax: 0,
            channel: pdfChannel,
            orderCount: 1,
            clientName: invoice.customer,
          })

          // Create strain rows from invoice lines
          for (const line of invoice.lines || []) {
            fileStrains.push({
              item: line.strain,
              strain: line.strain,
              packSize: line.packSize,
              sold: line.quantity,
              subtotal: line.lineTotal,
              channel: pdfChannel,
              year: invoiceDate.getFullYear(),
            })
          }

          // Save to server
          setUploadStatus(`Saving ${file.name} (${fileOrders.length} orders, ${fileStrains.length} strains)...`)
          const ok = await saveFileToServer(invoice.invoiceNumber + '.pdf', pdfChannel, 'orders', fileOrders, fileStrains)
          if (ok) successCount++; else failCount++
        } catch (e) {
          console.error(`Error processing ${file.name}:`, e)
          failCount++
          skippedFiles.push(`${file.name} (error: ${e instanceof Error ? e.message : String(e)})`)
        }
        continue
      }

      try {
        setUploadStatus(`Processing ${file.name}...`)
        const data = new Uint8Array(await file.arrayBuffer())
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
        if (rows.length === 0) { skippedFiles.push(`${file.name} (empty)`); continue }

        const headers = Object.keys(rows[0])
        const fileType = detectFileType(headers)
        if (!fileType) { skippedFiles.push(`${file.name} (unrecognized format: ${headers.join(', ')})`); continue }
        const channel = detectChannel(file.name)
        const fileOrders: OrderRow[] = [], fileStrains: StrainRow[] = []

        if (fileType === 'orders' || fileType === 'daily') {
          const dateCol = headers.find(h => h.toLowerCase() === 'date') || 'Date'
          const clientCol = headers.find(h => h.toLowerCase() === 'name')
          let subtotalCol: string, totalCol: string, taxCol: string, salesCol: string | null
          if (fileType === 'daily') {
            subtotalCol = headers.find(h => h.toLowerCase().includes('net total')) || 'Net Total (Excl. Tax)'
            totalCol = headers.find(h => h.toLowerCase().includes('sub total')) || 'Sub Total (Incl. Tax)'
            taxCol = ''; salesCol = headers.find(h => h.toLowerCase() === 'sales') || 'Sales'
          } else {
            subtotalCol = headers.find(h => h.toLowerCase() === 'subtotal') || 'Subtotal'
            totalCol = headers.find(h => h.toLowerCase() === 'total') || 'Total'
            taxCol = headers.find(h => h.toLowerCase() === 'tax') || 'Tax'
            salesCol = null
          }

          for (const row of rows) {
            const date = parseDate(row[dateCol])
            if (!date) continue
            const clientName = clientCol ? String(row[clientCol] || '') : ''
            if (fileType === 'daily') {
              const orderCount = salesCol ? toNum(row[salesCol]) : 1
              fileOrders.push({ date, subtotal: toNum(row[subtotalCol]), total: toNum(row[totalCol]), tax: 0, channel, orderCount, clientName: clientName || undefined })
            } else {
              fileOrders.push({ date, subtotal: toNum(row[subtotalCol]), total: toNum(row[totalCol]), tax: taxCol ? toNum(row[taxCol]) : 0, channel, orderCount: 1, clientName: clientName || undefined })
            }
          }
        } else if (fileType === 'basic_orders') {
          // Orders without dates (e.g. "Retail Orders (Basic)") — spread evenly across the date range from filename
          // Parse date range from filename like "01012026 to 17042026"
          const rangeMatch = file.name.match(/(\d{8})\s*to\s*(\d{8})/)
          const subtotalCol = headers.find(h => h.toLowerCase() === 'subtotal') || 'Subtotal'
          const totalCol = headers.find(h => h.toLowerCase() === 'total') || 'Total'
          const taxCol = headers.find(h => h.toLowerCase() === 'tax') || 'Tax'
          const clientCol = headers.find(h => h.toLowerCase() === 'name')

          if (rangeMatch) {
            // Parse start/end dates from DDMMYYYY format
            const parseRange = (s: string) => new Date(parseInt(s.slice(4)), parseInt(s.slice(2, 4)) - 1, parseInt(s.slice(0, 2)))
            const startDate = parseRange(rangeMatch[1])
            const endDate = parseRange(rangeMatch[2])

            // Group orders by month — assign each order a date spread across the range
            const totalOrders = rows.length
            const msRange = endDate.getTime() - startDate.getTime()

            for (let ri = 0; ri < rows.length; ri++) {
              const row = rows[ri]
              // Spread orders evenly across the date range
              const date = new Date(startDate.getTime() + (msRange * ri / totalOrders))
              const clientName = clientCol ? String(row[clientCol] || '') : ''
              fileOrders.push({ date, subtotal: toNum(row[subtotalCol]), total: toNum(row[totalCol]), tax: toNum(row[taxCol]), channel, orderCount: 1, clientName: clientName || undefined })
            }
          } else {
            // Fallback: assign all to Jan 1 of year from filename
            const year = detectYearFromFilename(file.name)
            for (const row of rows) {
              const clientName = clientCol ? String(row[clientCol] || '') : ''
              fileOrders.push({ date: new Date(year, 0, 1), subtotal: toNum(row[subtotalCol]), total: toNum(row[totalCol]), tax: toNum(row[taxCol]), channel, orderCount: 1, clientName: clientName || undefined })
            }
          }
        } else if (fileType === 'seeds') {
          // For seeds files with a date range (e.g. "01012023 to 21042026"),
          // use the END year so strains appear under the most recent year
          const dateMatches = file.name.match(/(\d{8})/g)
          let year: number
          if (dateMatches && dateMatches.length >= 2) {
            const endYear = parseInt(dateMatches[dateMatches.length - 1].slice(4))
            year = (endYear >= 2020 && endYear <= 2030) ? endYear : detectYearFromFilename(file.name)
          } else {
            year = detectYearFromFilename(file.name)
          }
          const itemCol = headers.find(h => h.toLowerCase() === 'item') || 'Item'
          const soldCol = headers.find(h => h.toLowerCase() === 'sold') || 'Sold'
          const subCol = headers.find(h => h.toLowerCase() === 'subtotal') || 'Subtotal'
          for (const row of rows) {
            const item = String(row[itemCol])
            const { strain, packSize } = parseStrain(item)
            fileStrains.push({ item, strain, packSize, sold: toNum(row[soldCol]), subtotal: toNum(row[subCol]), channel, year })
          }
        }
        // Save to server, then server is source of truth
        setUploadStatus(`Saving ${file.name} (${fileOrders.length} orders, ${fileStrains.length} strains)...`)
        const ok = await saveFileToServer(file.name, channel, fileType === 'basic_orders' ? 'orders' : fileType, fileOrders, fileStrains)
        if (ok) successCount++; else failCount++
      } catch (e) {
        console.error(`Error processing ${file.name}:`, e)
        failCount++
        skippedFiles.push(`${file.name} (error: ${e instanceof Error ? e.message : String(e)})`)
      }
    }
    // Reload all data from server to get clean, deduplicated state
    setUploadStatus('Loading data...')
    await loadFromServer()
    setUploading(false)
    const parts = []
    if (successCount > 0) parts.push(`${successCount} file${successCount > 1 ? 's' : ''} uploaded`)
    if (failCount > 0) parts.push(`${failCount} failed`)
    if (skippedFiles.length > 0) parts.push(`Skipped: ${skippedFiles.join('; ')}`)
    setUploadStatus(parts.join('. ') || 'No files processed')
    setTimeout(() => setUploadStatus(''), 10000)
  }, [saveFileToServer, loadFromServer])

  /* ── compute ───────────────────────────────────────────── */
  const retailData = useMemo(() => computeChannelData(yearData, years, 'retail', retailGrowth), [yearData, years, retailGrowth])
  const wholesaleData = useMemo(() => computeChannelData(yearData, years, 'wholesale', wholesaleGrowth), [yearData, years, wholesaleGrowth])
  const bulkData = useMemo(() => computeChannelData(yearData, years, 'bulk', bulkGrowth), [yearData, years, bulkGrowth])
  const growersData = useMemo(() => computeChannelData(yearData, years, 'growers', growersGrowth), [yearData, years, growersGrowth])
  const hasData = years.length > 0

  if (loadingData) return <Spinner text={`Loading ${REGION_CONFIG[region].label} data…`} />

  const uploadCard = (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-gray-800">{REGION_CONFIG[region].emoji} Upload {REGION_CONFIG[region].label} Reports</h2>
        {years.length > 0 && <span className="text-xs text-gray-500">{years.length} year{years.length !== 1 ? 's' : ''}: {years.join(', ')}</span>}
      </div>
      <label
        className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-6 py-8 cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-colors"
        onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); handleFiles(e.dataTransfer.files) }}
      >
        <input type="file" accept=".xlsx,.xls,.csv,.tsv,.pdf" multiple className="hidden" onChange={e => { if (e.target.files) handleFiles(e.target.files); e.target.value = '' }} />
        {uploading ? (
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-2 text-sm text-blue-600">
              <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              Processing…
            </div>
            {uploadStatus && <p className="text-xs text-gray-500">{uploadStatus}</p>}
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-gray-600">Drop files here or <span className="text-brand-600 underline">browse</span></p>
            <p className="text-xs text-gray-400 mt-1">Supports .xlsx, .xls, .csv, .pdf — Retail/Wholesale Orders, Seeds Sales, &amp; Bulk Invoices</p>
            {uploadStatus && <p className={`text-xs mt-1 ${uploadStatus.includes('failed') || uploadStatus.includes('Skipped') ? 'text-red-500' : 'text-green-600'}`}>{uploadStatus}</p>}
            {lastError && <p className="text-xs mt-1 text-red-500 break-all">Error: {lastError}</p>}
          </>
        )}
      </label>
      {years.length > 0 && (
        <div className="mt-3 space-y-1">
          {[...yearData.values()].sort((a, b) => a.year - b.year).map(yd => (
            <div key={yd.year} className="text-xs text-gray-500">
              <span className="font-semibold text-gray-700">{yd.year}:</span>{' '}
              {yd.files.map((f, i) => <span key={i} className="inline-block bg-gray-100 rounded px-1.5 py-0.5 mr-1 mb-1">{f}</span>)}
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Show upload at top when no data, at bottom when data exists */}
      {!hasData && uploadCard}

      {!hasData && (
        <div className="card text-center py-12">
          <p className="text-gray-400 text-sm">Upload {REGION_CONFIG[region].label} Excel or CSV reports above to get started.</p>
          <p className="text-gray-300 text-xs mt-1">Supports Retail Orders, Retail Seeds Sales, Wholesale Orders, and Wholesale Seeds Sales.</p>
        </div>
      )}

      {hasData && (
        <>
          <div className="card flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
              {(['charts', 'tables', 'both'] as ViewMode[]).map(v => (
                <button key={v} onClick={() => setViewMode(v)} className={`px-3 py-1.5 capitalize ${viewMode === v ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{v}</button>
              ))}
            </div>
            <button onClick={clearAllData} className="ml-auto text-xs text-red-500 hover:text-red-700 underline">Clear {REGION_CONFIG[region].label} data</button>
          </div>

          {renderChannelSection('Retail', '🛒', '#16a34a', years, retailData, viewMode, retailGrowth, setRetailGrowth, fmtCurrency, retailOpen, setRetailOpen, retailStrainYear, setRetailStrainYear)}
          {renderChannelSection('Wholesale', '📦', '#2563eb', years, wholesaleData, viewMode, wholesaleGrowth, setWholesaleGrowth, fmtCurrency, wholesaleOpen, setWholesaleOpen, wholesaleStrainYear, setWholesaleStrainYear)}
          {renderChannelSection('Bulk Seed Sales', '🌱', '#d97706', years, bulkData, viewMode, bulkGrowth, setBulkGrowth, fmtCurrency, bulkOpen, setBulkOpen, bulkStrainYear, setBulkStrainYear)}
          {renderChannelSection('Growers & Cultivators', '🌾', '#7c3aed', years, growersData, viewMode, growersGrowth, setGrowersGrowth, fmtCurrency, growersOpen, setGrowersOpen, growersStrainYear, setGrowersStrainYear)}

          {uploadCard}
        </>
      )}
    </div>
  )
}

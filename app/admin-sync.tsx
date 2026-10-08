'use client'

import { useState, useEffect, useCallback } from 'react'

/* "Sync from admin" bar for the USA tab: pulls retail orders from admin.barneysfarm.us */

interface LastRun { ran_at: string; ran_by: string; ok: boolean; complete: boolean; message: string }
interface SyncNext { since: string; until: string; startPage: number }

const token = () => localStorage.getItem('dashboard_session') || ''

export default function AdminSync({ onSynced }: { onSynced: () => Promise<void> }) {
  const [missing, setMissing] = useState<string[] | null>(null)
  const [last, setLast] = useState<LastRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [since, setSince] = useState('')

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin-sync', { headers: { Authorization: `Bearer ${token()}` } })
      if (!res.ok) return
      const data = await res.json()
      setMissing(data.missing || [])
      setLast(data.last || null)
    } catch { /* status bar just stays hidden */ }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  const sync = async () => {
    setBusy(true); setError(''); setStatus('Signing in to the admin…')
    let body: Partial<SyncNext> = since ? { since } : {}
    let total = 0
    try {
      // A long backfill comes back in parts; keep going until the admin says it's complete
      for (let part = 1; part <= 50; part++) {
        const res = await fetch('/api/admin-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => ({ error: res.statusText }))
        if (!res.ok) { setError(data.error || `Sync failed (${res.status})`); break }
        total += data.orders || 0
        if (data.complete) { setStatus(`Synced ${total.toLocaleString('en-US')} retail orders from the admin.`); break }
        setStatus(`Synced back to ${data.from} (${total.toLocaleString('en-US')} orders so far)…`)
        body = data.next
      }
      await onSynced()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      loadStatus()
    }
  }

  if (missing === null) return null

  if (missing.length > 0) {
    return (
      <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
        Admin sync isn&apos;t connected yet. Add {missing.join(', ')} in Vercel to pull retail orders from admin.barneysfarm.us automatically.
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={sync} disabled={busy} className="rounded-md bg-brand-600 text-white px-3 py-1.5 font-medium hover:bg-brand-700 disabled:opacity-50">
          {busy ? 'Syncing…' : 'Sync from admin'}
        </button>
        <label className="flex items-center gap-1 text-gray-500">
          from
          <input type="date" value={since} onChange={e => setSince(e.target.value)} disabled={busy} className="rounded border border-gray-300 px-1 py-0.5" />
        </label>
        <span className="text-gray-400">{since ? '' : '(blank = since the last sync)'}</span>
      </div>
      {status && <p className="text-green-700">{status}</p>}
      {error && <p className="text-red-600 break-words">{error}</p>}
      {last && !busy && (
        <p className={last.ok ? 'text-gray-500' : 'text-red-500'}>
          Last sync {new Date(last.ran_at).toLocaleString()} ({last.ran_by === 'cron' ? 'nightly' : last.ran_by}): {last.ok ? last.message : `failed. ${last.message}`}
        </p>
      )}
    </div>
  )
}

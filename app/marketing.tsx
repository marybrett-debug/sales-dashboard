'use client'

import { useEffect, useState } from 'react'

// Renders the self-contained Marketing dashboard (calendar, promos, partners,
// LinkedIn, strategy) in an iframe. The HTML is fetched with the session token,
// and a small shim adds that token to the dashboard's own /api/ calls
// (e.g. /api/promos) so they pass the same login check as the rest of the site.

export default function MarketingDashboard({ token }: { token: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/marketing', { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(res.status === 401 ? 'Your session has expired — please log in again.' : 'Could not load the marketing dashboard.')
        const page = await res.text()
        const shim = `<script>(function(){var f=window.fetch,t=${JSON.stringify(token)};window.fetch=function(u,o){var s=typeof u==='string'?u:(u&&u.url)||'';if(s.indexOf('/api/')===0){o=Object.assign({},o);var h=new Headers(o.headers||{});h.set('Authorization','Bearer '+t);o.headers=h;}return f.call(this,u,o);};})();</script>`
        if (!cancelled) setHtml(page.replace(/<head>/i, m => m + shim))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the marketing dashboard.')
      }
    })()
    return () => { cancelled = true }
  }, [token])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (html === null) return <p className="text-sm text-gray-500">Loading marketing dashboard…</p>

  return (
    <iframe
      title="Marketing Dashboard"
      srcDoc={html}
      className="w-full rounded-xl border border-gray-200 bg-white"
      style={{ height: 'calc(100vh - 110px)' }}
    />
  )
}

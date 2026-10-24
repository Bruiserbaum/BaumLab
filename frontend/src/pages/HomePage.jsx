import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth'
import { TileLink, buildTiles, gridStyle, groupTiles, matches } from '../components/launchpadTiles'

/**
 * /home — a full-screen start page. Signed in: every Launchpad tile (with status dots).
 * Not signed in: only tiles marked public, if the public home page is enabled.
 */
export default function HomePage() {
  const { token, authChecking, user } = useAuth()
  const [data, setData] = useState(null)
  const [mode, setMode] = useState(null)        // 'full' | 'public' | 'disabled'
  const [q, setQ] = useState('')
  const [now, setNow] = useState(new Date())
  const searchRef = useRef(null)

  useEffect(() => {
    if (authChecking) return
    ;(async () => {
      if (token) {
        const r = await fetch('/api/launchpad/', { headers: { Authorization: `Bearer ${token}` } })
        if (r.ok) {
          const d = await r.json()
          setData({ title: d.settings.title, group_order: d.settings.group_order,
                    tiles: buildTiles(d.services.filter(s => s.launchpad), d.bookmarks) })
          setMode('full')
          return
        }
      }
      const r = await fetch('/api/launchpad/public')
      const d = r.ok ? await r.json() : { enabled: false }
      if (!d.enabled) { setMode('disabled'); return }
      setData({ title: d.title, group_order: d.group_order, tiles: buildTiles(d.services, d.bookmarks) })
      setMode('public')
    })()
  }, [token, authChecking])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    const onKey = e => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey) }
  }, [])

  useEffect(() => { document.title = data?.title ? `${data.title} · BaumLab` : 'BaumLab' }, [data])

  const visible = useMemo(() => (data?.tiles ?? []).filter(t => matches(t, q)), [data, q])
  const groups = useMemo(() => groupTiles(visible, data?.group_order), [visible, data])

  function onSearchKey(e) {
    if (e.key === 'Enter' && visible[0]?.url) window.open(visible[0].url, '_blank', 'noopener')
    if (e.key === 'Escape') setQ('')
  }

  const hour = now.getHours()
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <div style={{ minHeight: '100vh', padding: '32px 24px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} ·{' '}
              {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </div>
            <h1 style={{ margin: '4px 0 0', fontSize: 26 }}>
              {mode === 'full' && user?.username ? `${greeting}, ${user.username}` : data?.title || 'BaumLab'}
            </h1>
          </div>
          {mode && mode !== 'disabled' && (
            <input ref={searchRef} autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={onSearchKey}
              placeholder="Search…  (Enter opens the first match)"
              style={{ flex: '1 1 280px', maxWidth: 460, fontSize: 15, padding: '10px 14px', marginLeft: 'auto' }} />
          )}
          <a href="/" style={{ fontSize: 13, color: 'var(--accent)', marginLeft: mode === 'disabled' ? 'auto' : 0 }}>
            {mode === 'full' ? 'Open BaumLab →' : 'Sign in →'}
          </a>
        </header>

        {mode === null && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        {mode === 'disabled' && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
            Sign in to see your links. <a href="/" style={{ color: 'var(--accent)' }}>Sign in →</a>
          </div>
        )}
        {mode && mode !== 'disabled' && data.tiles.length === 0 && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No links yet.</div>
        )}
        {mode && mode !== 'disabled' && data.tiles.length > 0 && visible.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>No matches for “{q}”.</p>
        )}

        {groups.map(([group, list]) => (
          <section key={group} style={{ marginBottom: 24 }}>
            <h2 style={{ marginBottom: 8 }}>{group}</h2>
            <div style={gridStyle}>
              {list.map(t => <TileLink key={t.key} tile={t} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

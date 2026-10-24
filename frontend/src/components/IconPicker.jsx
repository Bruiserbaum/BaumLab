import React, { useEffect, useRef, useState } from 'react'
import { useApi } from '../auth'

/** A stored library icon, or a coloured initial when there isn't one. */
export function AppIcon({ icon, name, size = 40 }) {
  const [broken, setBroken] = useState(false)
  if (icon && !broken) {
    return <img src={`/api/icons/file/${icon}`} alt="" width={size} height={size}
      style={{ objectFit: 'contain', flexShrink: 0 }} onError={() => setBroken(true)} />
  }
  const hue = [...(name || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)
  return (
    <div style={{ width: size, height: size, borderRadius: size / 4, flexShrink: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.45,
      background: `hsl(${hue} 45% 28%)`, color: `hsl(${hue} 80% 85%)` }}>
      {(name || '?').trim().charAt(0).toUpperCase()}
    </div>
  )
}

/** Modal: search Dashboard Icons (downloaded into the library on pick) or upload your own. */
export default function IconPicker({ name, current, onPick, onClose }) {
  const api = useApi()
  const [q, setQ] = useState(name || '')
  const [results, setResults] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    if (!q.trim()) { setResults([]); return }
    const t = setTimeout(async () => {
      const r = await api(`/api/icons/search?q=${encodeURIComponent(q)}`)
      const data = await r.json().catch(() => [])
      if (r.ok) { setResults(data); setError('') } else setError(data.detail || `HTTP ${r.status}`)
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  async function pick(item) {
    setBusy(true)
    const r = await api('/api/icons/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.name, format: item.format }),
    })
    const data = await r.json().catch(() => ({}))
    setBusy(false)
    if (r.ok) onPick(data.file)
    else setError(data.detail || `HTTP ${r.status}`)
  }

  async function upload(e) {
    const file = e.target.files[0]
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    const r = await api('/api/icons/upload', { method: 'POST', body: fd })
    const data = await r.json().catch(() => ({}))
    if (r.ok) onPick(data.file)
    else setError(data.detail || `HTTP ${r.status}`)
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 60,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 640, maxWidth: '100%', marginBottom: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <AppIcon icon={current} name={name} size={32} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search icons — plex, proxmox, unifi…"
            onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
            style={{ flex: 1 }} />
          <button type="button" className="secondary" onClick={() => fileRef.current.click()}>Upload…</button>
          <input ref={fileRef} type="file" accept=".svg,.png,.webp,.jpg,.jpeg,.ico,.gif" hidden onChange={upload} />
          <button type="button" className="secondary" onClick={onClose}>✕</button>
        </div>
        {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 8,
          maxHeight: '50vh', overflowY: 'auto', opacity: busy ? 0.5 : 1 }}>
          {results.map(item => (
            <button type="button" key={item.name} className="secondary" onClick={() => pick(item)} disabled={busy}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 8 }}>
              <img src={item.preview} alt="" width={40} height={40} loading="lazy" style={{ objectFit: 'contain' }} />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{item.name}</span>
            </button>
          ))}
        </div>
        {q && results.length === 0 && !error && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No matches.</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>Icons from <a href="https://github.com/homarr-labs/dashboard-icons" target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent)' }}>Dashboard Icons</a> — saved into BaumLab when picked.</span>
          {current && <button type="button" className="secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => onPick('')}>Remove icon</button>}
        </div>
      </div>
    </div>
  )
}

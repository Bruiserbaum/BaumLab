import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, useAuth } from '../auth'
import IconPicker, { AppIcon } from '../components/IconPicker'

const API = '/api/launchpad'
const STATUS_DOT = { true: 'var(--green)', false: 'var(--red)' }

async function call(api, url, options = {}) {
  const isJson = typeof options.body === 'string'
  const r = await api(url, isJson ? { ...options, headers: { 'Content-Type': 'application/json' } } : options)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${r.status}`)
  return data
}

function Tile({ tile, editing, onIcon, onToggle, onEdit, onDelete }) {
  const hidden = tile.kind === 'service' && !tile.launchpad
  const body = (
    <>
      <AppIcon icon={tile.icon} name={tile.name} size={40} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tile.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {tile.subtitle}
        </div>
      </div>
      {tile.status != null && (
        <span title={tile.status ? 'Up' : 'Down'} style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
          background: STATUS_DOT[tile.status], boxShadow: tile.status ? 'none' : '0 0 6px var(--red)' }} />
      )}
    </>
  )
  const style = { display: 'flex', alignItems: 'center', gap: 12, padding: 12, marginBottom: 0, color: 'var(--text)',
                  textDecoration: 'none', opacity: hidden ? 0.4 : 1, minHeight: 64 }
  if (!editing) {
    return tile.url
      ? <a className="card" href={tile.url} target="_blank" rel="noreferrer" style={style}>{body}</a>
      : <div className="card" style={{ ...style, opacity: 0.5 }} title="No URL — set one on the Services page">{body}</div>
  }
  return (
    <div className="card" style={{ ...style, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{body}</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onIcon}>Icon</button>
        {tile.kind === 'service'
          ? <button className="secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onToggle}>{hidden ? 'Show' : 'Hide'}</button>
          : <>
              <button className="secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onEdit}>Edit</button>
              <button className="secondary" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)' }} onClick={onDelete}>✕</button>
            </>}
      </div>
    </div>
  )
}

function BookmarkForm({ api, initial, groups, onDone, onCancel }) {
  const [form, setForm] = useState({ name: '', url: '', group: 'Bookmarks', description: '', icon: null, ...initial })
  const [error, setError] = useState('')
  async function save(e) {
    e.preventDefault()
    try {
      await call(api, initial?.id ? `${API}/bookmarks/${initial.id}` : `${API}/bookmarks`, {
        method: initial?.id ? 'PUT' : 'POST', body: JSON.stringify(form),
      })
      onDone()
    } catch (err) { setError(err.message) }
  }
  return (
    <form className="card" onSubmit={save} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <input required placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      <input required placeholder="https://…" value={form.url} style={{ width: 280 }} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
      <input list="lp-groups" placeholder="Group" value={form.group} onChange={e => setForm(f => ({ ...f, group: e.target.value }))} />
      <datalist id="lp-groups">{groups.map(g => <option key={g} value={g} />)}</datalist>
      <button type="submit">{initial?.id ? 'Save' : 'Add bookmark'}</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
    </form>
  )
}

const ACTIONS = [['link', 'Attach to service'], ['service', 'Create service'], ['bookmark', 'Add as bookmark'], ['skip', 'Skip']]

function HeimdallImport({ api, onDone, onClose }) {
  const [data, setData] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  async function load(file) {
    setBusy(true); setError('')
    try {
      let result
      if (file) {
        const fd = new FormData()
        fd.append('file', file)
        result = await call(api, `${API}/heimdall/preview`, { method: 'POST', body: fd })
      } else {
        result = await call(api, `${API}/heimdall/preview`, { method: 'POST' })
      }
      setData(result)
      setRows(result.items)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }
  useEffect(() => { load() }, [])

  const update = (key, patch) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r))

  async function apply() {
    setBusy(true)
    try {
      const r = await call(api, `${API}/heimdall/apply`, { method: 'POST', body: JSON.stringify(rows) })
      onDone(`Heimdall import: ${r.linked} attached to services, ${r.services} services created, ${r.bookmarks} bookmarks`)
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>Import from Heimdall</h2>
        {data && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} links from {data.source}</span>}
        <button className="secondary" style={{ marginLeft: 'auto' }} onClick={() => fileRef.current.click()}>Upload app.sqlite…</button>
        <input ref={fileRef} type="file" hidden onChange={e => e.target.files[0] && load(e.target.files[0])} />
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Links matching a service attach to it (adding the icon and URL if missing). Internal addresses default to new
        services, everything else to bookmarks. Change anything before importing.
      </p>
      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
      {busy && !data && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Reading Heimdall…</div>}
      {rows.length > 0 && <>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 12 }}>
            <thead><tr><th></th><th>Name</th><th>URL</th><th>Group</th><th>Action</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} style={{ opacity: r.action === 'skip' ? 0.45 : 1 }}>
                  <td>
                    {r.icon ? <AppIcon icon={r.icon} name={r.title} size={24} />
                      : r.suggested_icon ? <img src={`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${r.suggested_icon}.svg`}
                          width={24} height={24} alt="" title="Suggested from Dashboard Icons" onError={e => { e.target.style.display = 'none' }} />
                      : <AppIcon name={r.title} size={24} />}
                  </td>
                  <td><input value={r.title} style={{ fontSize: 12, padding: '3px 6px' }} onChange={e => update(r.key, { title: e.target.value })} /></td>
                  <td style={{ fontFamily: 'monospace', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>{r.url}</td>
                  <td><input value={r.group} style={{ fontSize: 12, padding: '3px 6px', width: 120 }} onChange={e => update(r.key, { group: e.target.value })} /></td>
                  <td>
                    <select value={r.action} style={{ fontSize: 12, padding: '3px 6px' }} onChange={e => update(r.key, { action: e.target.value })}>
                      {ACTIONS.filter(([a]) => a !== 'link' || r.match_id).map(([a, label]) => (
                        <option key={a} value={a}>{a === 'link' ? `Attach to ${r.match_name}` : label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button style={{ marginTop: 12 }} onClick={apply} disabled={busy}>
          {busy ? 'Importing…' : `Import ${rows.filter(r => r.action !== 'skip').length} links`}
        </button>
      </>}
    </div>
  )
}

export default function LaunchpadPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState(null)        // tile whose icon is being changed
  const [bookmarkForm, setBookmarkForm] = useState(null)
  const [showHeimdall, setShowHeimdall] = useState(false)
  const [notice, setNotice] = useState(null)
  const searchRef = useRef(null)
  const importRef = useRef(null)

  async function load() {
    try { setData(await call(api, `${API}/`)) } catch (e) { setNotice({ ok: false, text: e.message }) }
  }
  useEffect(() => { load() }, [])

  // "/" focuses search from anywhere on the page
  useEffect(() => {
    const onKey = e => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tiles = useMemo(() => {
    if (!data) return []
    return [
      ...data.services.map(s => ({ ...s, kind: 'service', key: `s${s.id}`, subtitle: s.host || (s.url || '').replace(/^https?:\/\//, '') })),
      ...data.bookmarks.map(b => ({ ...b, kind: 'bookmark', key: `b${b.id}`, launchpad: true, status: null,
                                   subtitle: b.description || b.url.replace(/^https?:\/\//, '') })),
    ]
  }, [data])

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    return tiles.filter(t => (editing || t.launchpad) && (!s || [t.name, t.group, t.subtitle].some(v => v && v.toLowerCase().includes(s))))
  }, [tiles, q, editing])

  const groups = useMemo(() => {
    const map = new Map()
    for (const t of visible) {
      if (!map.has(t.group)) map.set(t.group, [])
      map.get(t.group).push(t)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visible])

  async function setIcon(tile, icon) {
    setPicking(null)
    try {
      if (tile.kind === 'service') await call(api, `${API}/services/${tile.id}`, { method: 'PATCH', body: JSON.stringify({ icon }) })
      else await call(api, `${API}/bookmarks/${tile.id}`, { method: 'PUT', body: JSON.stringify({ ...tile, icon: icon || null }) })
      load()
    } catch (e) { setNotice({ ok: false, text: e.message }) }
  }

  async function toggle(tile) {
    await call(api, `${API}/services/${tile.id}`, { method: 'PATCH', body: JSON.stringify({ launchpad: !tile.launchpad }) })
      .catch(e => setNotice({ ok: false, text: e.message }))
    load()
  }

  async function removeBookmark(tile) {
    if (!confirm(`Delete bookmark ${tile.name}?`)) return
    await call(api, `${API}/bookmarks/${tile.id}`, { method: 'DELETE' }).catch(e => setNotice({ ok: false, text: e.message }))
    load()
  }

  async function autoIcons() {
    try {
      const r = await call(api, '/api/icons/auto-assign', { method: 'POST' })
      setNotice({ ok: true, text: `Icons assigned to ${r.assigned.length}` + (r.missing.length ? ` · no match for ${r.missing.join(', ')}` : '') })
      load()
    } catch (e) { setNotice({ ok: false, text: e.message }) }
  }

  async function exportLaunchpad() {
    try {
      const data = await call(api, `${API}/export`)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `baumlab-launchpad-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) { setNotice({ ok: false, text: e.message }) }
  }

  async function importLaunchpad(file) {
    try {
      const payload = JSON.parse(await file.text())
      const r = await call(api, `${API}/import`, { method: 'POST', body: JSON.stringify(payload) })
      setNotice({ ok: true, text: `Imported: ${r.services_updated} services updated, ${r.services_created} created, ${r.bookmarks} bookmarks` })
      load()
    } catch (e) { setNotice({ ok: false, text: `Import failed: ${e.message}` }) }
  }

  function onSearchKey(e) {
    if (e.key === 'Enter' && visible[0]?.url) window.open(visible[0].url, '_blank', 'noopener')
    if (e.key === 'Escape') setQ('')
  }

  if (!data) return <div><h1>Launchpad</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const groupNames = [...new Set(tiles.map(t => t.group))]

  return (
    <div>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <h1 style={{ margin: '0 12px 0 0' }}>Launchpad</h1>
        <input ref={searchRef} autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={onSearchKey}
          placeholder="Search…  (/ to focus, Enter opens first)" style={{ width: 300 }} />
        <button className={editing ? '' : 'secondary'} onClick={() => setEditing(v => !v)}>{editing ? 'Done' : '✎ Edit'}</button>
        {editing && <button className="secondary" onClick={() => setBookmarkForm({})}>+ Bookmark</button>}
        {isAdmin && editing && <>
          <button className="secondary" onClick={autoIcons}>Auto-assign icons</button>
          <button className="secondary" onClick={() => setShowHeimdall(true)}>Import from Heimdall</button>
          <button className="secondary" onClick={exportLaunchpad}>Export</button>
          <button className="secondary" onClick={() => importRef.current.click()}>Import</button>
          <input ref={importRef} type="file" accept=".json,application/json" hidden
            onChange={e => { if (e.target.files[0]) importLaunchpad(e.target.files[0]); e.target.value = '' }} />
        </>}
      </div>

      {notice && (
        <div style={{ fontSize: 12, marginBottom: 12, padding: '8px 12px', borderRadius: 6, display: 'flex', justifyContent: 'space-between',
          color: notice.ok ? 'var(--green)' : 'var(--red)', border: `1px solid ${notice.ok ? 'var(--green)' : 'var(--red)'}` }}>
          {notice.ok ? '✓' : '✗'} {notice.text}<span style={{ cursor: 'pointer' }} onClick={() => setNotice(null)}>✕</span>
        </div>
      )}

      {showHeimdall && <HeimdallImport api={api} onClose={() => setShowHeimdall(false)}
        onDone={text => { setShowHeimdall(false); setNotice({ ok: true, text }); load() }} />}
      {bookmarkForm && <BookmarkForm api={api} initial={bookmarkForm} groups={groupNames}
        onCancel={() => setBookmarkForm(null)} onDone={() => { setBookmarkForm(null); load() }} />}

      {tiles.length === 0 && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          Nothing here yet. Tiles appear for every service on the <Link to="/services" style={{ color: 'var(--accent)' }}>Services</Link> page
          {isAdmin && <> — or click ✎ Edit → Import from Heimdall</>}.
        </div>
      )}
      {tiles.length > 0 && visible.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No matches for “{q}”.</div>}

      {groups.map(([group, list]) => (
        <section key={group} style={{ marginBottom: 20 }}>
          <h2 style={{ marginBottom: 8 }}>{group}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {list.map(t => (
              <Tile key={t.key} tile={t} editing={editing} onIcon={() => setPicking(t)} onToggle={() => toggle(t)}
                onEdit={() => setBookmarkForm(t)} onDelete={() => removeBookmark(t)} />
            ))}
          </div>
        </section>
      ))}

      {picking && <IconPicker name={picking.name} current={picking.icon} onClose={() => setPicking(null)}
        onPick={icon => setIcon(picking, icon)} />}
    </div>
  )
}

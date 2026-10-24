import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, useAuth } from '../auth'
import IconPicker, { AppIcon } from '../components/IconPicker'
import { TileBody, TileLink, buildTiles, gridStyle, groupTiles, matches, tileStyle } from '../components/launchpadTiles'

const API = '/api/launchpad'

async function call(api, url, options = {}) {
  const isJson = typeof options.body === 'string'
  const r = await api(url, isJson ? { ...options, headers: { 'Content-Type': 'application/json' } } : options)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${r.status}`)
  return data
}

const smallBtn = { fontSize: 11, padding: '2px 8px' }

/** Edit-mode tile: draggable, with icon / visibility / public controls. */
function EditTile({ tile, isAdmin, draggable, dragging, onDragStart, onDragEnd, onDrop, onIcon, onToggle, onPublic, onEdit, onDelete }) {
  const hidden = tile.kind === 'service' && !tile.launchpad
  return (
    <div className="card" draggable={draggable}
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
      onDragEnd={onDragEnd}
      onDragOver={e => { if (draggable) e.preventDefault() }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop() }}
      style={{ ...tileStyle, flexDirection: 'column', alignItems: 'stretch', gap: 8, cursor: draggable ? 'grab' : 'default',
               opacity: dragging ? 0.35 : hidden ? 0.45 : 1, borderStyle: hidden ? 'dashed' : 'solid' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {draggable && <span style={{ color: 'var(--text-muted)', fontSize: 14 }} title="Drag to move">⠿</span>}
        <TileBody tile={tile} />
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button className="secondary" style={smallBtn} onClick={onIcon}>Icon</button>
        {tile.kind === 'service'
          ? <button className="secondary" style={smallBtn} onClick={onToggle}>{hidden ? 'Show' : 'Hide'}</button>
          : <>
              <button className="secondary" style={smallBtn} onClick={onEdit}>Edit</button>
              <button className="secondary" style={{ ...smallBtn, color: 'var(--red)' }} onClick={onDelete}>✕</button>
            </>}
        {isAdmin && (
          <button className="secondary" onClick={onPublic} title="Show on the home page without signing in"
            style={{ ...smallBtn, marginLeft: 'auto', color: tile.public ? 'var(--green)' : 'var(--text-muted)',
                     borderColor: tile.public ? 'var(--green)' : 'var(--border)' }}>
            {tile.public ? '🌐 Public' : 'Private'}
          </button>
        )}
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


function HomeSettings({ api, settings, onSaved }) {
  const [enabled, setEnabled] = useState(settings.public_enabled)
  const [title, setTitle] = useState(settings.title)
  const [error, setError] = useState('')
  async function save() {
    try { onSaved(await call(api, `${API}/settings`, { method: 'PUT', body: JSON.stringify({ public_enabled: enabled, title }) })) }
    catch (e) { setError(e.message) }
  }
  return (
    <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
      <b>Home page</b>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Show 🌐 public tiles to visitors who aren't signed in
      </label>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" style={{ width: 160 }} />
      <button className="secondary" onClick={save}>Save</button>
      {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexBasis: '100%' }}>
        Signed-in users always see every tile at <code>/home</code>. Behind Authentik, anonymous visitors only reach
        it if the proxy lets <code>/home</code>, <code>/assets</code>, <code>/api/launchpad/public</code> and <code>/api/icons/file</code> through without login.
      </span>
    </div>
  )
}

export default function LaunchpadPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState(false)
  const [dragKey, setDragKey] = useState(null)
  const [picking, setPicking] = useState(null)
  const [bookmarkForm, setBookmarkForm] = useState(null)
  const [showHeimdall, setShowHeimdall] = useState(false)
  const [notice, setNotice] = useState(null)
  const searchRef = useRef(null)
  const importRef = useRef(null)

  async function load() {
    try { setData(await call(api, `${API}/`)) } catch (e) { setNotice({ ok: false, text: e.message }) }
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    const onKey = e => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tiles = useMemo(() => data ? buildTiles(data.services, data.bookmarks) : [], [data])
  const visible = useMemo(() => tiles.filter(t => (editing || t.launchpad) && matches(t, q)), [tiles, q, editing])
  const groups = useMemo(() => groupTiles(visible, data?.settings.group_order), [visible, data])
  const canDrag = editing && !q.trim()   // positions are only meaningful with the full list showing

  const fail = e => setNotice({ ok: false, text: e.message })

  /** Apply new {group, order} values locally, then persist them. */
  function applyLayout(changes, groupOrder) {
    const byKey = Object.fromEntries(changes.map(c => [`${c.kind === 'service' ? 's' : 'b'}${c.id}`, c]))
    setData(d => ({
      ...d,
      settings: groupOrder ? { ...d.settings, group_order: groupOrder } : d.settings,
      services: d.services.map(s => byKey[`s${s.id}`] ? { ...s, ...byKey[`s${s.id}`], kind: undefined } : s),
      bookmarks: d.bookmarks.map(b => byKey[`b${b.id}`] ? { ...b, ...byKey[`b${b.id}`], kind: undefined } : b),
    }))
    call(api, `${API}/layout`, { method: 'PUT', body: JSON.stringify({ tiles: changes, group_order: groupOrder ?? null }) })
      .catch(e => { fail(e); load() })
  }

  /** Move the dragged tile before `beforeKey` (or to the end) of `targetGroup`. */
  function moveTile(targetGroup, beforeKey = null) {
    if (!dragKey || dragKey === beforeKey) return
    const layout = new Map(groups.map(([g, list]) => [g, list.map(t => t.key)]))
    const source = [...layout.entries()].find(([, keys]) => keys.includes(dragKey))?.[0]
    if (source === undefined) return
    layout.set(source, layout.get(source).filter(k => k !== dragKey))
    const target = layout.get(targetGroup) ?? []
    const at = beforeKey ? target.indexOf(beforeKey) : -1
    target.splice(at === -1 ? target.length : at, 0, dragKey)
    layout.set(targetGroup, target)
    const byKey = Object.fromEntries(tiles.map(t => [t.key, t]))
    const changes = [...new Set([source, targetGroup])].flatMap(g =>
      layout.get(g).map((key, i) => ({ kind: byKey[key].kind, id: byKey[key].id, group: g, order: (i + 1) * 10 })))
    applyLayout(changes)
    setDragKey(null)
  }

  function moveGroup(group, dir) {
    const names = groups.map(([g]) => g)
    const i = names.indexOf(group)
    const j = i + dir
    if (j < 0 || j >= names.length) return
    ;[names[i], names[j]] = [names[j], names[i]]
    applyLayout([], names)
  }

  async function patchTile(tile, body) {
    await call(api, `${API}/${tile.kind === 'service' ? 'services' : 'bookmarks'}/${tile.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .catch(fail)
    load()
  }

  async function removeBookmark(tile) {
    if (!confirm(`Delete bookmark ${tile.name}?`)) return
    await call(api, `${API}/bookmarks/${tile.id}`, { method: 'DELETE' }).catch(fail)
    load()
  }

  async function autoIcons() {
    try {
      const r = await call(api, '/api/icons/auto-assign', { method: 'POST' })
      setNotice({ ok: true, text: `Icons assigned to ${r.assigned.length}` + (r.missing.length ? ` · no match for ${r.missing.join(', ')}` : '') })
      load()
    } catch (e) { fail(e) }
  }

  async function exportLaunchpad() {
    try {
      const payload = await call(api, `${API}/export`)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
      a.download = `baumlab-launchpad-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) { fail(e) }
  }

  async function importLaunchpad(file) {
    try {
      const r = await call(api, `${API}/import`, { method: 'POST', body: await file.text() })
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
        <a href="/home" target="_blank" rel="noreferrer" className="secondary"
          style={{ fontSize: 13, color: 'var(--accent)', marginLeft: 4 }}>Home page ↗</a>
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

      {editing && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-6px 0 12px' }}>
          {canDrag ? 'Drag tiles to reorder or move them between groups; ↑↓ reorder groups.' : 'Clear the search to drag tiles.'}
          {' '}Dashed tiles are hidden from the Launchpad.
        </p>
      )}

      {notice && (
        <div style={{ fontSize: 12, marginBottom: 12, padding: '8px 12px', borderRadius: 6, display: 'flex', justifyContent: 'space-between',
          color: notice.ok ? 'var(--green)' : 'var(--red)', border: `1px solid ${notice.ok ? 'var(--green)' : 'var(--red)'}` }}>
          {notice.ok ? '✓' : '✗'} {notice.text}<span style={{ cursor: 'pointer' }} onClick={() => setNotice(null)}>✕</span>
        </div>
      )}

      {isAdmin && editing && <HomeSettings api={api} settings={data.settings}
        onSaved={settings => { setData(d => ({ ...d, settings })); setNotice({ ok: true, text: 'Home page settings saved' }) }} />}
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

      {groups.map(([group, list], gi) => (
        <section key={group} style={{ marginBottom: 20 }}
          onDragOver={e => { if (canDrag) e.preventDefault() }}
          onDrop={e => { e.preventDefault(); moveTile(group) }}>
          <h2 style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            {group}
            {canDrag && <>
              <button className="secondary" style={smallBtn} disabled={gi === 0} onClick={() => moveGroup(group, -1)}>↑</button>
              <button className="secondary" style={smallBtn} disabled={gi === groups.length - 1} onClick={() => moveGroup(group, 1)}>↓</button>
            </>}
          </h2>
          <div style={{ ...gridStyle, minHeight: canDrag ? 70 : undefined }}>
            {list.map(t => editing ? (
              <EditTile key={t.key} tile={t} isAdmin={isAdmin} draggable={canDrag} dragging={dragKey === t.key}
                onDragStart={() => setDragKey(t.key)} onDragEnd={() => setDragKey(null)} onDrop={() => moveTile(group, t.key)}
                onIcon={() => setPicking(t)} onToggle={() => patchTile(t, { launchpad: !t.launchpad })}
                onPublic={() => patchTile(t, { public: !t.public })}
                onEdit={() => setBookmarkForm(t)} onDelete={() => removeBookmark(t)} />
            ) : <TileLink key={t.key} tile={t} />)}
          </div>
        </section>
      ))}

      {picking && <IconPicker name={picking.name} current={picking.icon} onClose={() => setPicking(null)}
        onPick={icon => { setPicking(null); patchTile(picking, { icon }) }} />}
    </div>
  )
}

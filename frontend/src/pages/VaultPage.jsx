import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../auth'

const API = '/api'
const HIDE_AFTER_MS = 30_000

const blank = { service_id: '', title: '', username: '', secret: '', url: '', notes: '' }

function generatePassword(length = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
  const bytes = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(bytes, b => chars[b % chars.length]).join('')
}

function Field({ label, children, style }) {
  return (
    <label style={style}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  )
}

export default function VaultPage() {
  const api = useApi()
  const [params, setParams]     = useSearchParams()
  const [status, setStatus]     = useState(null)
  const [entries, setEntries]   = useState([])
  const [services, setServices] = useState([])
  const [audit, setAudit]       = useState([])
  const [showAudit, setShowAudit] = useState(false)
  const [search, setSearch]     = useState('')
  const [form, setForm]         = useState(blank)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId]     = useState(null)
  const [showSecret, setShowSecret] = useState(false)
  const [revealed, setRevealed] = useState({})   // id → { secret, notes }
  const [toast, setToast]       = useState('')
  const [error, setError]       = useState('')
  const timers = useRef({})

  const serviceFilter = params.get('service') || ''

  async function load() {
    const s = await api(`${API}/vault/status`)
    if (!s.ok) { setStatus({ locked: true, reason: `HTTP ${s.status}` }); return }
    const st = await s.json()
    setStatus(st)
    if (st.locked) return
    const [e, sv] = await Promise.all([api(`${API}/vault/`), api(`${API}/services/`)])
    if (e.ok) setEntries(await e.json())
    if (sv.ok) setServices(await sv.json())
    if (showAudit) loadAudit()
  }

  async function loadAudit() {
    const r = await api(`${API}/vault/audit?limit=200`)
    if (r.ok) setAudit(await r.json())
  }

  useEffect(() => { load() }, [])
  useEffect(() => { if (showAudit) loadAudit() }, [showAudit])
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), [])

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  async function fetchSecret(id) {
    const r = await api(`${API}/vault/${id}/reveal`, { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { setError(data.detail || `HTTP ${r.status}`); return null }
    return data
  }

  async function reveal(id) {
    if (revealed[id]) { hide(id); return }
    const data = await fetchSecret(id)
    if (!data) return
    setRevealed(x => ({ ...x, [id]: data }))
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => hide(id), HIDE_AFTER_MS)
  }

  function hide(id) {
    clearTimeout(timers.current[id])
    setRevealed(x => { const { [id]: _, ...rest } = x; return rest })
  }

  async function copy(text, label) {
    if (!navigator.clipboard) { setError('Clipboard needs HTTPS — use 👁 to reveal instead'); return }
    await navigator.clipboard.writeText(text)
    flash(`${label} copied`)
  }

  async function copySecret(id) {
    const data = revealed[id] ?? await fetchSecret(id)
    if (data) await copy(data.secret, 'Password')
  }

  function openAdd() {
    setEditId(null)
    setForm({ ...blank, service_id: serviceFilter })
    setShowSecret(false)
    setShowForm(true)
  }

  function openEdit(e) {
    setEditId(e.id)
    setForm({ ...blank, service_id: e.service_id ?? '', title: e.title, username: e.username ?? '', url: e.url ?? '' })
    setShowSecret(false)
    setShowForm(true)
  }

  function cancelForm() {
    setShowForm(false)
    setEditId(null)
    setForm(blank)
  }

  async function submit(ev) {
    ev.preventDefault()
    setError('')
    const body = {
      service_id: form.service_id !== '' ? +form.service_id : null,
      title: form.title.trim(),
      username: form.username.trim() || null,
      url: form.url.trim() || null,
      // When editing, blank secret/notes mean "keep what's stored"
      secret: editId != null && form.secret === '' ? null : form.secret,
      notes: editId != null && form.notes === '' ? null : form.notes,
    }
    const r = await api(editId != null ? `${API}/vault/${editId}` : `${API}/vault/`, {
      method: editId != null ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) { setError((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`); return }
    if (editId != null) hide(editId)
    cancelForm()
    await load()
  }

  async function remove(e) {
    if (!confirm(`Delete "${e.title}" from the vault? This cannot be undone.`)) return
    await api(`${API}/vault/${e.id}`, { method: 'DELETE' })
    hide(e.id)
    await load()
  }

  function setServiceFilter(value) {
    if (value) setParams({ service: value })
    else setParams({})
  }

  const serviceName = useMemo(() => Object.fromEntries(services.map(s => [s.id, s.name])), [services])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e =>
      (!serviceFilter || String(e.service_id) === serviceFilter) &&
      (!q || [e.title, e.username, e.url, serviceName[e.service_id]]
        .some(v => v && v.toLowerCase().includes(q))))
  }, [entries, search, serviceFilter, serviceName])

  if (!status) return <div><h1>Vault</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  if (status.locked) return (
    <div style={{ maxWidth: 700 }}>
      <h1>Vault</h1>
      <div className="card" style={{ borderColor: 'var(--red)' }}>
        <div style={{ fontWeight: 600, color: 'var(--red)', marginBottom: 6 }}>🔒 Vault locked</div>
        <div style={{ fontSize: 13 }}>{status.reason}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          See <code>.env.example</code> for how to set these, then redeploy the stack.
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <h1>Vault</h1>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-8px 0 16px' }}>
        Encrypted with {status.key_source}. Admin-only; every reveal and copy is logged. Passwords
        hide again after {HIDE_AFTER_MS / 1000}s and are never included in Git sync or PDF exports.
      </p>

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <button onClick={showForm && editId == null ? cancelForm : openAdd}>
          {showForm && editId == null ? 'Cancel' : '+ Add Credential'}
        </button>
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        <select value={serviceFilter} onChange={e => setServiceFilter(e.target.value)}>
          <option value="">All services</option>
          {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="secondary" onClick={load}>Refresh</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={showAudit} onChange={e => setShowAudit(e.target.checked)} />
          Audit log
        </label>
        {toast && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ {toast}</span>}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--red)', background: '#2e1a1a', border: '1px solid var(--red)',
          borderRadius: 6, padding: '8px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
          {error}
          <span style={{ cursor: 'pointer' }} onClick={() => setError('')}>✕</span>
        </div>
      )}

      {showForm && (
        <form className="card" onSubmit={submit} autoComplete="off">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <Field label="Service">
              <select value={form.service_id} onChange={e => setForm(x => ({ ...x, service_id: e.target.value }))}>
                <option value="">None</option>
                {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Title">
              <input required value={form.title} placeholder="Admin login"
                onChange={e => setForm(x => ({ ...x, title: e.target.value }))} />
            </Field>
            <Field label="Username">
              <input value={form.username} autoComplete="off"
                onChange={e => setForm(x => ({ ...x, username: e.target.value }))} />
            </Field>
            <Field label={editId != null ? 'Password — blank keeps current' : 'Password'}>
              <div style={{ display: 'flex', gap: 4 }}>
                <input type={showSecret ? 'text' : 'password'} value={form.secret} autoComplete="new-password"
                  style={{ width: 220, fontFamily: 'monospace' }}
                  onChange={e => setForm(x => ({ ...x, secret: e.target.value }))} />
                <button type="button" className="secondary" title="Show / hide"
                  onClick={() => setShowSecret(v => !v)}>👁</button>
                <button type="button" className="secondary" title="Generate a random password"
                  onClick={() => { setForm(x => ({ ...x, secret: generatePassword() })); setShowSecret(true) }}>⚄</button>
              </div>
            </Field>
            <Field label="Login URL">
              <input value={form.url} placeholder="https://…" style={{ width: 220 }}
                onChange={e => setForm(x => ({ ...x, url: e.target.value }))} />
            </Field>
          </div>
          <Field label={editId != null ? 'Notes (encrypted) — blank keeps current' : 'Notes (encrypted) — recovery codes, etc.'}>
            <textarea value={form.notes} rows={3}
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12, background: 'var(--bg2)',
                color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                fontFamily: 'inherit', fontSize: 13 }}
              onChange={e => setForm(x => ({ ...x, notes: e.target.value }))} />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit">{editId != null ? 'Save' : 'Add'}</button>
            <button type="button" className="secondary" onClick={cancelForm}>Cancel</button>
          </div>
        </form>
      )}

      {entries.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          The vault is empty. Click “+ Add Credential” to store your first password.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Title</th>
              <th>Username</th>
              <th>Password</th>
              <th>Login URL</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(e => {
              const shown = revealed[e.id]
              return (
                <React.Fragment key={e.id}>
                  <tr style={editId === e.id ? { background: 'var(--bg2)' } : {}}>
                    <td>{e.service_id != null ? serviceName[e.service_id] ?? '—' : '—'}</td>
                    <td style={{ fontWeight: 500 }}>{e.title}</td>
                    <td>
                      {e.username ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: 'monospace' }}>{e.username}</span>
                          <button className="secondary" style={{ padding: '2px 6px' }} title="Copy username"
                            onClick={() => copy(e.username, 'Username')}>📋</button>
                        </span>
                      ) : '—'}
                    </td>
                    <td>
                      {e.has_secret ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: 'monospace', minWidth: 90, userSelect: shown ? 'text' : 'none' }}>
                            {shown ? shown.secret : '••••••••'}
                          </span>
                          <button className="secondary" style={{ padding: '2px 6px' }}
                            title={shown ? 'Hide' : 'Reveal'} onClick={() => reveal(e.id)}>👁</button>
                          <button className="secondary" style={{ padding: '2px 6px' }} title="Copy password"
                            onClick={() => copySecret(e.id)}>📋</button>
                        </span>
                      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td>
                      {e.url
                        ? <a href={e.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 12 }}>
                            {e.url.replace(/^https?:\/\//, '')} ↗
                          </a>
                        : '—'}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(e.updated_at + 'Z').toLocaleDateString()}
                      {e.updated_by && <> · {e.updated_by}</>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="secondary" onClick={() => openEdit(e)}>✎ Edit</button>
                        <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(e)}>✕</button>
                      </div>
                    </td>
                  </tr>
                  {shown && shown.notes && (
                    <tr>
                      <td></td>
                      <td colSpan={6} style={{ whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'monospace',
                        color: 'var(--text-muted)' }}>
                        {shown.notes}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {showAudit && (
        <div style={{ marginTop: 24 }}>
          <h2>Audit log</h2>
          <table>
            <thead>
              <tr><th>When</th><th>User</th><th>Action</th><th>Entry</th></tr>
            </thead>
            <tbody>
              {audit.map(a => (
                <tr key={a.id}>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(a.at + 'Z').toLocaleString()}</td>
                  <td>{a.actor}</td>
                  <td>
                    <span className={`badge badge-${a.action === 'reveal' ? 'yellow' : a.action === 'delete' ? 'red' : 'gray'}`}>
                      {a.action}
                    </span>
                  </td>
                  <td>{a.entry_title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

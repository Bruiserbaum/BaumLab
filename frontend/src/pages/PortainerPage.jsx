import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useApi, useAuth } from '../auth'
import ContainerPanel, { containerKey } from '../components/ContainerPanel'

const API = import.meta.env.VITE_API_URL ?? ''
const REFRESH_MS = 30_000

const STATE_COLORS = {
  running: 'var(--green)', paused: '#d4b800', created: '#4f9fe8',
  restarting: '#e87a30', exited: '#e87a30', dead: '#ff4444',
}

export default function PortainerPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [services, setServices] = useState([])
  const [openContainer, setOpenContainer] = useState(null)
  const [linkError, setLinkError] = useState('')
  const [containers, setContainers] = useState([])
  const [statuses, setStatuses] = useState([])
  const [connFilter, setConnFilter] = useState('All')
  const [stateFilter, setStateFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [polling, setPolling] = useState(false)
  const [loading, setLoading] = useState(false)

  // Connection form
  const [showForm, setShowForm] = useState(false)
  const [connections, setConnections] = useState([])
  const [form, setForm] = useState({ name: '', url: 'http://', api_key: '', enabled: true })
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null)

  const intervalRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (connFilter !== 'All') params.set('connection', connFilter)
      if (stateFilter !== 'all') params.set('state', stateFilter)
      if (search) params.set('search', search)
      const [cR, sR, svR] = await Promise.all([
        api(`${API}/api/portainer/containers?${params}`),
        api(`${API}/api/portainer/status`),
        api(`${API}/api/services/`),
      ])
      if (cR.ok) setContainers(await cR.json())
      if (sR.ok) setStatuses(await sR.json())
      if (svR.ok) setServices(await svR.json())
    } finally {
      setLoading(false)
    }
  }, [api, connFilter, stateFilter, search])

  const loadConnections = useCallback(async () => {
    const r = await api(`${API}/api/portainer/connections`)
    if (r.ok) setConnections(await r.json())
  }, [api])

  // Services linked to a container (Services → Platform: docker → Container)
  const serviceByContainer = Object.fromEntries(services.filter(s => s.container_name).map(s =>
    [containerKey(s.container_connection, s.container_endpoint_id, s.container_name), s]))

  async function addService(c) {
    setLinkError('')
    const r = await api(`${API}/api/services/from-container`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: c.connection_name, endpoint_id: c.endpoint_id, name: c.name }),
    })
    if (!r.ok) { setLinkError((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`); return }
    load()
  }

  useEffect(() => {
    load()
    intervalRef.current = setInterval(load, REFRESH_MS)
    return () => clearInterval(intervalRef.current)
  }, [load])

  useEffect(() => {
    if (isAdmin) loadConnections()
  }, [isAdmin, loadConnections])

  async function triggerPoll() {
    setPolling(true)
    try {
      await api(`${API}/api/portainer/poll`, { method: 'POST' })
      await load()
    } finally {
      setPolling(false)
    }
  }

  async function saveConnection(e) {
    e.preventDefault()
    setSaving(true)
    setSaveResult(null)
    try {
      const r = await api(`${API}/api/portainer/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        setSaveResult({ ok: false, message: data.detail || `Save failed (HTTP ${r.status})` })
        return
      }
      // Saved either way; the test tells you whether BaumLab can actually use it
      setSaveResult({ ok: data.test?.ok, message: `Saved ${form.name}. ${data.test?.message ?? ''}` })
      if (data.test?.ok) setForm({ name: '', url: 'http://', api_key: '', enabled: true })
      await Promise.all([loadConnections(), load()])
    } catch (err) {
      setSaveResult({ ok: false, message: err.message })
    } finally {
      setSaving(false)
    }
  }

  async function deleteConnection(name) {
    if (!confirm(`Remove connection "${name}"?`)) return
    await api(`${API}/api/portainer/connections/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await loadConnections()
  }

  const connNames = ['All', ...new Set(containers.map(c => c.connection_name))]
  const unhealthyCount = containers.filter(c => ['exited', 'dead', 'restarting'].includes(c.state)).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>

      {/* Status cards */}
      {statuses.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {statuses.map(s => (
            <div key={s.name} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '10px 16px', minWidth: 160,
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{s.name}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.unhealthy > 0 ? '#e87a30' : 'var(--green)' }}>
                {s.running}/{s.total}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {s.unhealthy > 0
                  ? <span style={{ color: '#e87a30' }}>{s.unhealthy} unhealthy</span>
                  : 'all running'}
                {s.checked_at && (
                  <> · {new Date(s.checked_at).toLocaleTimeString()}</>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={connFilter} onChange={e => setConnFilter(e.target.value)} style={{ width: 140 }}>
          {connNames.map(n => <option key={n}>{n}</option>)}
        </select>
        <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} style={{ width: 120 }}>
          <option value="all">All States</option>
          <option value="running">Running</option>
          <option value="exited">Exited</option>
          <option value="dead">Dead</option>
          <option value="restarting">Restarting</option>
        </select>
        <input
          placeholder="Search name / image…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 200 }}
        />
        <button onClick={load} disabled={loading}>Refresh</button>
        {isAdmin && (
          <button className="secondary" onClick={triggerPoll} disabled={polling}>
            {polling ? 'Polling…' : 'Poll Now'}
          </button>
        )}
        {unhealthyCount > 0 && (
          <span style={{ color: '#e87a30', fontSize: 13, fontWeight: 600 }}>
            ⚠ {unhealthyCount} unhealthy
          </span>
        )}
        {isAdmin && (
          <button
            className="secondary"
            style={{ marginLeft: 'auto' }}
            onClick={() => { setShowForm(!showForm); loadConnections() }}
          >
            {showForm ? 'Hide' : 'Manage Connections'}
          </button>
        )}
      </div>

      {/* Connection manager */}
      {showForm && isAdmin && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Portainer Connections</h3>

          {connections.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Name', 'URL', 'API Key', 'Enabled', ''].map(h => (
                    <th key={h} style={{ ...th, textAlign: 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {connections.map(c => (
                  <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={td}>{c.name}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{c.url}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{c.api_key || '—'}</td>
                    <td style={td}>{c.enabled ? '✓' : '✗'}</td>
                    <td style={td}>
                      <button className="secondary" style={{ fontSize: 11, padding: '2px 8px' }}
                        onClick={() => deleteConnection(c.name)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form onSubmit={saveConnection} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              Name
              <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: 120 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              Portainer URL
              <input required value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} style={{ width: 220 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              API Key
              <input type="password" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} style={{ width: 180 }} />
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
              Enabled
            </label>
            <button type="submit" disabled={saving}>{saving ? 'Testing…' : 'Add / Update'}</button>
          </form>
          {saveResult && (
            <div style={{ fontSize: 12, marginTop: 8, color: saveResult.ok ? 'var(--green)' : 'var(--red)' }}>
              {saveResult.ok ? '✓' : '✗'} {saveResult.message}
            </div>
          )}
        </div>
      )}

      {linkError && <div style={{ fontSize: 12, color: 'var(--red)', margin: '0 0 8px' }}>✗ {linkError}</div>}

      {/* Container table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <th style={th}>Connection</th>
              <th style={th}>Endpoint</th>
              <th style={th}>Name</th>
              <th style={th}>Service</th>
              <th style={th}>Image</th>
              <th style={th}>State</th>
              <th style={th}>Status</th>
              <th style={th}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {[...containers]
              .sort((a, b) => {
                const unhealthy = s => ['exited', 'dead', 'restarting'].includes(s)
                if (unhealthy(a.state) !== unhealthy(b.state)) return unhealthy(a.state) ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              .map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => setOpenContainer(c)} title="Details, logs, start / stop / restart">
                  <td style={td}>{c.connection_name}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{c.endpoint_name}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{c.name}</td>
                  <td style={td} onClick={e => e.stopPropagation()}>
                    {serviceByContainer[containerKey(c.connection_name, c.endpoint_id, c.name)]
                      ? <a href="/services" style={{ color: 'var(--accent)' }}>
                          {serviceByContainer[containerKey(c.connection_name, c.endpoint_id, c.name)].name}</a>
                      : <button className="secondary" style={{ fontSize: 11, padding: '1px 8px' }}
                          onClick={() => addService(c)} title="Add this container to the Services inventory">+ Service</button>}
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>
                    {c.image.length > 50 ? c.image.slice(0, 50) + '…' : c.image}
                  </td>
                  <td style={{ ...td, color: STATE_COLORS[c.state] ?? 'var(--text-muted)', fontWeight: 600, textTransform: 'capitalize' }}>
                    {c.state}
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)', fontSize: 11 }}>{c.status_text}</td>
                  <td style={{ ...td, color: 'var(--text-muted)', fontSize: 11 }}>
                    {new Date(c.checked_at).toLocaleTimeString()}
                  </td>
                </tr>
              ))
            }
            {containers.length === 0 && !loading && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                  No containers. Add a Portainer connection in the connection manager above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openContainer && (
        <ContainerPanel api={api} container={openContainer} onClose={() => setOpenContainer(null)}
          onChanged={async () => {
            await load()
            setOpenContainer(null)
          }} />
      )}
    </div>
  )
}

const th = { padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }
const td = { padding: '5px 10px', color: 'var(--text)' }

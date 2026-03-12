import React, { useEffect, useState, useCallback } from 'react'
import { useApi } from '../auth'

const API = '/api'
const PROTOCOLS = ['icmp', 'tcp', 'http', 'https']
const REFRESH_MS = 30_000

const blank = { name: '', host: '', port: null, protocol: 'icmp', interval_seconds: 60, enabled: true }

const OVERALL_CFG = {
  operational: { bg: 'rgba(35,134,54,0.15)',  border: '#238636', dot: '#3fb950', text: '#3fb950', label: 'All Systems Operational' },
  degraded:    { bg: 'rgba(210,153,34,0.15)', border: '#d29922', dot: '#e3b341', text: '#e3b341', label: 'Partial Outage'           },
  outage:      { bg: 'rgba(218,54,51,0.15)',  border: '#da3633', dot: '#f85149', text: '#f85149', label: 'Major Outage'             },
  unknown:     { bg: 'transparent',           border: '#30363d', dot: '#8b949e', text: '#8b949e', label: 'No Data'                  },
}

function ago(isoString) {
  if (!isoString) return '—'
  const secs = Math.floor((Date.now() - new Date(isoString + 'Z').getTime()) / 1000)
  if (secs < 60)  return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60)  return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

export default function MonitorsPage() {
  const api = useApi()
  const [targets, setTargets]     = useState([])
  const [statusMap, setStatusMap] = useState({})   // id → status object from /api/status/public
  const [overall, setOverall]     = useState('unknown')
  const [upCount, setUpCount]     = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [form, setForm]           = useState(blank)
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState(null)

  const loadStatus = useCallback(async () => {
    try {
      const r    = await fetch(`${API}/status/public`)
      const data = await r.json()
      const map  = {}
      for (const m of data.monitors ?? []) map[m.id] = m
      setStatusMap(map)
      setOverall(data.overall ?? 'unknown')
      setUpCount(data.up ?? 0)
      setTotalCount(data.total ?? 0)
    } catch { /* ignore — status is cosmetic */ }
  }, [])

  async function loadTargets() {
    const r = await api(`${API}/monitors/`)
    setTargets(await r.json())
  }

  async function load() {
    await Promise.all([loadTargets(), loadStatus()])
  }

  useEffect(() => {
    load()
    const interval = setInterval(loadStatus, REFRESH_MS)
    return () => clearInterval(interval)
  }, [])

  function openAdd() {
    setEditId(null)
    setForm(blank)
    setShowForm(true)
  }

  function openEdit(t) {
    setEditId(t.id)
    setForm({ name: t.name, host: t.host, port: t.port, protocol: t.protocol,
              interval_seconds: t.interval_seconds, enabled: t.enabled })
    setShowForm(true)
  }

  function cancelForm() {
    setShowForm(false)
    setEditId(null)
    setForm(blank)
  }

  async function submit(e) {
    e.preventDefault()
    const body = { ...form, port: form.port ? +form.port : null }
    if (editId != null) {
      await api(`${API}/monitors/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } else {
      await api(`${API}/monitors/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    cancelForm()
    await load()
  }

  async function remove(id) {
    if (!confirm('Delete this monitor?')) return
    await api(`${API}/monitors/${id}`, { method: 'DELETE' })
    await load()
  }

  const cfg = OVERALL_CFG[overall]

  return (
    <div>
      <h1>Monitors</h1>

      {/* ── Overall status banner ──────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 16px', marginBottom: 20,
        background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8,
      }}>
        <div style={{
          width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
          background: cfg.dot,
          boxShadow: overall !== 'unknown' ? `0 0 7px ${cfg.dot}` : 'none',
        }} />
        <span style={{ fontWeight: 600, color: cfg.text }}>{cfg.label}</span>
        {totalCount > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>
            {upCount} / {totalCount} up
          </span>
        )}
      </div>

      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="toolbar">
        <button onClick={showForm && editId == null ? cancelForm : openAdd}>
          {showForm && editId == null ? 'Cancel' : '+ Add Monitor'}
        </button>
        <button className="secondary" onClick={load}>Refresh</button>
      </div>

      {/* ── Add / Edit form ────────────────────────────────────── */}
      {showForm && (
        <form className="card" onSubmit={submit}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Name</div>
            <input required value={form.name} onChange={e => setForm(x => ({ ...x, name: e.target.value }))} />
          </label>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Host / IP</div>
            <input required value={form.host} onChange={e => setForm(x => ({ ...x, host: e.target.value }))} />
          </label>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Protocol</div>
            <select value={form.protocol} onChange={e => setForm(x => ({ ...x, protocol: e.target.value }))}>
              {PROTOCOLS.map(p => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Port</div>
            <input type="number" value={form.port ?? ''} style={{ width: 70 }}
              onChange={e => setForm(x => ({ ...x, port: e.target.value || null }))} />
          </label>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Interval (s)</div>
            <input type="number" value={form.interval_seconds} style={{ width: 80 }}
              onChange={e => setForm(x => ({ ...x, interval_seconds: +e.target.value }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Enabled</div>
            <select value={form.enabled ? 'true' : 'false'}
              onChange={e => setForm(x => ({ ...x, enabled: e.target.value === 'true' }))}>
              <option value="true">Active</option>
              <option value="false">Paused</option>
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit">{editId != null ? 'Save' : 'Add'}</button>
            <button type="button" className="secondary" onClick={cancelForm}>Cancel</button>
          </div>
        </form>
      )}

      {/* ── Monitor table ──────────────────────────────────────── */}
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Name</th>
            <th>Host</th>
            <th>Protocol</th>
            <th>Port</th>
            <th>Interval</th>
            <th>Latency</th>
            <th>Last Check</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {targets.map(t => {
            const s       = statusMap[t.id]
            const isUp    = s?.is_up === true
            const isDown  = s?.is_up === false
            const dot     = isUp ? '#3fb950' : isDown ? '#f85149' : '#8b949e'
            const latency = s?.latency_ms != null ? `${Math.round(s.latency_ms)} ms` : '—'

            return (
              <tr key={t.id} style={editId === t.id ? { background: 'var(--bg2)' } : {}}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div style={{
                      width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                      background: dot,
                      boxShadow: isDown ? `0 0 5px ${dot}` : 'none',
                    }} />
                    <span style={{ fontSize: 12, color: dot }}>
                      {isUp ? 'Up' : isDown ? 'Down' : '—'}
                    </span>
                  </div>
                </td>
                <td>{t.name}</td>
                <td style={{ fontFamily: 'monospace' }}>{t.host}</td>
                <td><span className="badge badge-gray">{t.protocol}</span></td>
                <td>{t.port ?? '—'}</td>
                <td>{t.interval_seconds}s</td>
                <td style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{latency}</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>{ago(s?.checked_at)}</td>
                <td>
                  <span className={`badge badge-${t.enabled ? 'green' : 'gray'}`}>
                    {t.enabled ? 'active' : 'paused'}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="secondary" onClick={() => openEdit(t)}>✎ Edit</button>
                  <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(t.id)}>✕</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

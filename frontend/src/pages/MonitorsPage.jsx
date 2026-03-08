import React, { useEffect, useState } from 'react'

const API = '/api'
const PROTOCOLS = ['icmp', 'tcp', 'http', 'https']

const blank = { name: '', host: '', port: null, protocol: 'icmp', interval_seconds: 60, enabled: true }

export default function MonitorsPage() {
  const [targets, setTargets] = useState([])
  const [form, setForm] = useState(blank)
  const [showForm, setShowForm] = useState(false)

  async function load() {
    const r = await fetch(`${API}/monitors/`)
    setTargets(await r.json())
  }

  useEffect(() => { load() }, [])

  async function submit(e) {
    e.preventDefault()
    await fetch(`${API}/monitors/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, port: form.port ? +form.port : null }),
    })
    setForm(blank)
    setShowForm(false)
    await load()
  }

  async function remove(id) {
    if (!confirm('Delete this monitor?')) return
    await fetch(`${API}/monitors/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div>
      <h1>Monitors</h1>
      <div className="toolbar">
        <button onClick={() => setShowForm(s => !s)}>{showForm ? 'Cancel' : '+ Add Monitor'}</button>
        <button className="secondary" onClick={load}>Refresh</button>
      </div>

      {showForm && (
        <form className="card" onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
          <button type="submit">Add</button>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Host</th>
            <th>Protocol</th>
            <th>Port</th>
            <th>Interval</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {targets.map(t => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td style={{ fontFamily: 'monospace' }}>{t.host}</td>
              <td><span className="badge badge-gray">{t.protocol}</span></td>
              <td>{t.port ?? '—'}</td>
              <td>{t.interval_seconds}s</td>
              <td>
                <span className={`badge badge-${t.enabled ? 'green' : 'gray'}`}>
                  {t.enabled ? 'active' : 'paused'}
                </span>
              </td>
              <td>
                <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(t.id)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

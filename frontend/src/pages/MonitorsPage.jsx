import React, { useEffect, useState } from 'react'
import { useApi } from '../auth'

const API = '/api'
const PROTOCOLS = ['icmp', 'tcp', 'http', 'https']

const blank = { name: '', host: '', port: null, protocol: 'icmp', interval_seconds: 60, enabled: true }

export default function MonitorsPage() {
  const api = useApi()
  const [targets, setTargets]   = useState([])
  const [form, setForm]         = useState(blank)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId]     = useState(null)  // null = add mode, number = edit mode

  async function load() {
    const r = await api(`${API}/monitors/`)
    setTargets(await r.json())
  }

  useEffect(() => { load() }, [])

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

  return (
    <div>
      <h1>Monitors</h1>
      <div className="toolbar">
        <button onClick={showForm && editId == null ? cancelForm : openAdd}>
          {showForm && editId == null ? 'Cancel' : '+ Add Monitor'}
        </button>
        <button className="secondary" onClick={load}>Refresh</button>
      </div>

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
            <tr key={t.id} style={editId === t.id ? { background: 'var(--bg2)' } : {}}>
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
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="secondary" onClick={() => openEdit(t)}>✎ Edit</button>
                <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(t.id)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

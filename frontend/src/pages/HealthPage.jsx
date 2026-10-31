import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, useAuth } from '../auth'

const API = '/api/system'
const SEVERITY = {
  error:   { color: 'var(--red)', label: 'Error' },
  warning: { color: 'var(--yellow)', label: 'Warning' },
  info:    { color: '#58a6ff', label: 'Info' },
  fixed:   { color: 'var(--green)', label: 'Fixed' },
}

function ago(iso) {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()) / 60000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
}

function Findings({ title, items, empty }) {
  return (
    <section className="card">
      <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>
        {title} {items.length > 0 && <span className="badge badge-gray">{items.length}</span>}
      </h2>
      {items.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{empty}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((f, i) => (
            <Link key={i} to={f.link} style={{ display: 'flex', gap: 10, fontSize: 13, color: 'var(--text)', textDecoration: 'none' }}>
              <span style={{ color: SEVERITY[f.severity].color, minWidth: 64, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
                {SEVERITY[f.severity].label}
              </span>
              <span className="badge badge-gray" style={{ alignSelf: 'flex-start' }}>{f.check}</span>
              <span>{f.text}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

function LogCollection({ api }) {
  const [cfg, setCfg] = useState(null)
  const [names, setNames] = useState([])
  const [saved, setSaved] = useState('')

  async function load() {
    const [c, n] = await Promise.all([api(`${API}/logs`), api(`${API}/containers`)])
    if (c.ok) setCfg(await c.json())
    if (n.ok) setNames(await n.json())
  }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [])

  async function save() {
    const r = await api(`${API}/logs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
    if (r.ok) { setCfg(await r.json()); setSaved('Saved — changes apply within a minute'); setTimeout(() => setSaved(''), 4000) }
  }

  if (!cfg) return null
  const st = cfg.status
  const toggle = name => setCfg(c => ({ ...c, containers: c.containers.includes(name) ? c.containers.filter(x => x !== name) : [...c.containers, name] }))

  return (
    <section className="card">
      <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, color: 'var(--text)' }}>Container logs → Syslog</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        BaumLab follows container output through the Docker socket and files each line in{' '}
        <Link to="/syslog?source=container" style={{ color: 'var(--accent)' }}>Syslog</Link> under the container's name,
        with a severity guessed from the text (ERROR, WARNING…). Only new lines are collected.
      </p>
      <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={cfg.collect} onChange={e => setCfg(c => ({ ...c, collect: e.target.checked }))} />
        Collect container logs
      </label>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
        Containers — none ticked = BaumLab's own stack (api, ui, OpenVAS)
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', maxHeight: 140, overflowY: 'auto',
        border: '1px solid var(--border)', borderRadius: 6, padding: 8, marginBottom: 10 }}>
        {names.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Docker socket not available</span>}
        {names.map(n => (
          <label key={n} style={{ fontSize: 12, display: 'flex', gap: 5 }}>
            <input type="checkbox" checked={cfg.containers.includes(n)} onChange={() => toggle(n)} />{n}
          </label>
        ))}
      </div>
      <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={cfg.keep_access_logs} onChange={e => setCfg(c => ({ ...c, keep_access_logs: e.target.checked }))} />
        Keep successful web-request lines (noisy — off by default)
      </label>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {[['max_network', 'Keep network syslog rows'], ['max_container', 'Keep container log rows']].map(([k, label]) => (
          <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            {label}
            <input type="number" min={1000} step={1000} value={cfg[k]} style={{ width: 120 }}
              onChange={e => setCfg(c => ({ ...c, [k]: +e.target.value }))} />
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={save}>Save</button>
        {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ {saved}</span>}
        <span style={{ fontSize: 12, color: st.error ? 'var(--red)' : 'var(--text-muted)', marginLeft: 'auto' }}>
          {st.error ? `✗ ${st.error}` : st.running ? `Following ${st.following.length}: ${st.following.join(', ') || '—'}` : 'Not collecting'}
          {st.dropped > 0 && ` · ${st.dropped} lines dropped (backlog full)`}
        </span>
      </div>
    </section>
  )
}

export default function HealthPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [data, setData] = useState(null)
  const [running, setRunning] = useState(false)

  async function load(run = false) {
    setRunning(run)
    const r = await api(run ? `${API}/integrity/run` : `${API}/integrity`, { method: run ? 'POST' : 'GET' })
    if (r.ok) setData(await r.json())
    setRunning(false)
  }
  useEffect(() => { if (isAdmin) load() }, [isAdmin])

  if (!isAdmin) return <div><h1>Health</h1><p style={{ color: 'var(--text-muted)' }}>Admin access required.</p></div>

  const findings = data?.findings ?? []
  const problems = findings.filter(f => f.severity === 'error' || f.severity === 'warning')
  const notes = findings.filter(f => f.severity === 'info')
  const fixes = findings.filter(f => f.severity === 'fixed')

  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Health</h1>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Background checks run every 15 minutes · last run {ago(data?.ran_at)}
        </span>
        <button style={{ marginLeft: 'auto' }} onClick={() => load(true)} disabled={running}>
          {running ? 'Checking…' : '⟳ Run checks now'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-6px 0 16px' }}>
        Keeps linked pieces in sync — SSH services ↔ Terminal hosts, vault entries, monitors, Docker containers,
        backup jobs, icons, schedules — repairing what's safe automatically and listing what needs you.
        {data?.startup && (data.startup.interrupted_runs > 0 || data.startup.closed_sessions > 0) &&
          ` At the last start-up it closed ${data.startup.interrupted_runs} interrupted backup run(s) and ${data.startup.closed_sessions} terminal session(s).`}
      </p>

      {!data ? <p style={{ color: 'var(--text-muted)' }}>Running checks…</p> : <>
        <Findings title="Needs attention" items={problems} empty="✓ Nothing needs attention." />
        <Findings title="Repaired automatically (last run)" items={fixes} empty="Nothing needed repairing." />
        {notes.length > 0 && <Findings title="Notes" items={notes} empty="" />}
      </>}

      <LogCollection api={api} />
    </div>
  )
}

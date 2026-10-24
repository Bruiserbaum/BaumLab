import React, { useEffect, useState } from 'react'
import { useApi, useAuth } from '../auth'

const API = '/api/alerts'
const MASK = '••••••••'

// type → [field, label, placeholder, kind]
const FIELDS = {
  ntfy: [['server', 'Server', 'https://ntfy.sh'], ['topic', 'Topic', 'baumlab-alerts'], ['token', 'Access token', 'optional', 'secret']],
  discord: [['webhook_url', 'Webhook URL', 'https://discord.com/api/webhooks/…', 'secret']],
  email: [
    ['host', 'SMTP host', 'smtp.gmail.com'], ['port', 'Port', '587', 'number'], ['security', 'Security', '', 'security'],
    ['username', 'Username', ''], ['password', 'Password', 'app password', 'secret'],
    ['from_addr', 'From', 'baumlab@example.com'], ['to_addrs', 'To', 'you@example.com, other@example.com'],
  ],
  webhook: [['url', 'URL', 'https://… (receives JSON: event, severity, title, message, url, time)', 'secret']],
}
const TYPE_LABELS = { ntfy: 'ntfy', discord: 'Discord', email: 'Email (SMTP)', webhook: 'Webhook (Gotify, Home Assistant, …)' }
const SEVERITY_BADGE = { info: 'blue', warning: 'yellow', critical: 'red' }

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, flex: 1, minWidth: 160 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  )
}

function Channel({ ch, onChange, onRemove, onTest, test }) {
  const set = patch => onChange({ ...ch, ...patch })
  const setting = (k, v) => onChange({ ...ch, settings: { ...ch.settings, [k]: v } })
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Name"><input value={ch.name} onChange={e => set({ name: e.target.value })} /></Field>
        <Field label="Type">
          <select value={ch.type} onChange={e => set({ type: e.target.value, settings: {} })} disabled={!!ch.id}>
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Send">
          <select value={ch.min_severity} onChange={e => set({ min_severity: e.target.value })}>
            <option value="info">Everything (incl. recoveries, updates)</option>
            <option value="warning">Warnings and critical</option>
            <option value="critical">Critical only</option>
          </select>
        </Field>
        <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center', marginBottom: 14 }}>
          <input type="checkbox" checked={ch.enabled} onChange={e => set({ enabled: e.target.checked })} /> Enabled
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FIELDS[ch.type].map(([key, label, placeholder, kind]) => (
          <Field key={key} label={label}>
            {kind === 'security' ? (
              <select value={ch.settings[key] || 'starttls'} onChange={e => setting(key, e.target.value)}>
                <option value="starttls">STARTTLS (587)</option>
                <option value="ssl">SSL/TLS (465)</option>
                <option value="none">None</option>
              </select>
            ) : (
              <input type={kind === 'secret' ? 'password' : kind === 'number' ? 'number' : 'text'}
                autoComplete={kind === 'secret' ? 'new-password' : 'off'}
                value={ch.settings[key] === MASK ? '' : ch.settings[key] ?? ''}
                placeholder={ch.settings[key] === MASK ? 'Saved — enter new to change' : placeholder}
                onChange={e => setting(key, e.target.value === '' && ch.settings[key] === MASK ? MASK : e.target.value)} />
            )}
          </Field>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="secondary" onClick={onTest} disabled={!ch.id} title={ch.id ? '' : 'Save first'}>
          Send test
        </button>
        <button type="button" className="secondary" style={{ color: 'var(--red)' }} onClick={onRemove}>Remove</button>
        {test && <span style={{ fontSize: 12, color: test.ok ? 'var(--green)' : 'var(--red)' }}>{test.ok ? '✓' : '✗'} {test.message}</span>}
      </div>
    </div>
  )
}

export default function AlertsPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [config, setConfig] = useState(null)
  const [history, setHistory] = useState([])
  const [saved, setSaved] = useState(null)
  const [tests, setTests] = useState({})

  async function load() {
    const [c, h] = await Promise.all([api(`${API}/config`), api(`${API}/history?limit=100`)])
    if (c.ok) setConfig(await c.json())
    if (h.ok) setHistory(await h.json())
  }
  useEffect(() => { if (isAdmin) load() }, [isAdmin])

  if (!isAdmin) return <div><h1>Alerts</h1><p style={{ color: 'var(--text-muted)' }}>Admin access required.</p></div>
  if (!config) return <div><h1>Alerts</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const setChannels = fn => setConfig(c => ({ ...c, channels: fn(c.channels) }))

  async function save() {
    const r = await api(`${API}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
    })
    const data = await r.json().catch(() => ({}))
    if (r.ok) { setConfig(data); setSaved({ ok: true, text: 'Saved' }) }
    else setSaved({ ok: false, text: data.detail || `HTTP ${r.status}` })
    setTimeout(() => setSaved(null), 3000)
  }

  async function test(id) {
    setTests(t => ({ ...t, [id]: { ok: true, message: 'Sending…' } }))
    const r = await api(`${API}/test/${id}`, { method: 'POST' })
    const data = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }))
    setTests(t => ({ ...t, [id]: data }))
  }

  return (
    <div style={{ maxWidth: 980 }}>
      <h1>Alerts</h1>

      <section className="card">
        <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, color: 'var(--text)' }}>Channels</h2>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
          Where alerts go. Secrets are stored encrypted. Every alert is also kept in the history below.
        </p>
        {config.channels.map((ch, i) => (
          <Channel key={ch.id || `new-${i}`} ch={ch} test={tests[ch.id]}
            onChange={updated => setChannels(list => list.map((x, j) => j === i ? updated : x))}
            onRemove={() => setChannels(list => list.filter((_, j) => j !== i))}
            onTest={() => test(ch.id)} />
        ))}
        <button type="button" className="secondary" style={{ marginTop: 12 }}
          onClick={() => setChannels(list => [...list, { name: '', type: 'ntfy', enabled: true, min_severity: 'warning',
                                                        settings: { server: 'https://ntfy.sh' } }])}>
          + Add channel
        </button>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 15, color: 'var(--text)' }}>What to alert on</h2>
        {Object.entries(config.event_types).map(([key, label]) => (
          <label key={key} style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={config.events[key]}
              onChange={e => setConfig(c => ({ ...c, events: { ...c.events, [key]: e.target.checked } }))} />
            {label}
          </label>
        ))}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
          <Field label="Failed checks before a monitor counts as down">
            <input type="number" min={1} max={20} value={config.monitor_failures} style={{ width: 90 }}
              onChange={e => setConfig(c => ({ ...c, monitor_failures: +e.target.value }))} />
          </Field>
          <Field label="BaumLab address (for links in alerts)">
            <input value={config.public_url} placeholder="https://baumlab.example.com"
              onChange={e => setConfig(c => ({ ...c, public_url: e.target.value }))} />
          </Field>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 24 }}>
        <button onClick={save}>Save alert settings</button>
        {saved && <span style={{ fontSize: 12, color: saved.ok ? 'var(--green)' : 'var(--red)' }}>{saved.ok ? '✓' : '✗'} {saved.text}</span>}
      </div>

      <h2>History</h2>
      {history.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No alerts yet.</div>
      ) : (
        <table>
          <thead><tr><th>When</th><th>Severity</th><th>Alert</th><th>Delivered</th></tr></thead>
          <tbody>
            {history.map(a => (
              <tr key={a.id}>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{new Date(a.at + 'Z').toLocaleString()}</td>
                <td><span className={`badge badge-${SEVERITY_BADGE[a.severity] ?? 'gray'}`}>{a.severity}</span></td>
                <td>
                  <div style={{ fontWeight: 500 }}>{a.title}</div>
                  {a.message && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.message}</div>}
                </td>
                <td style={{ fontSize: 12 }}>
                  {a.delivery.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>no channels</span> :
                    a.delivery.map((d, i) => (
                      <div key={i} style={{ color: d.ok ? 'var(--green)' : 'var(--red)' }} title={d.error || ''}>
                        {d.ok ? '✓' : '✗'} {d.channel}{d.error ? `: ${d.error}` : ''}
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

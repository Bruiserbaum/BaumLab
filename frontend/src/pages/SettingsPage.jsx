import React, { useEffect, useState } from 'react'
import { useAuth, useApi } from '../auth'

const MASK = '••••••••'

const blankUnifi = { url: '', username: '', password: '', site: 'default', verify_ssl: false }
const blankScan  = { default_cidr: '192.168.1.0/24', auto_scan: false, auto_scan_interval_minutes: 60 }

export default function SettingsPage() {
  const { isAdmin } = useAuth()
  const api = useApi()
  const [unifi, setUnifi]     = useState(blankUnifi)
  const [scan, setScan]       = useState(blankScan)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(true)
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    api('/api/settings/').then(r => r.json()).then(data => {
      if (data.unifi) setUnifi({ ...blankUnifi, ...data.unifi })
      if (data.scan)  setScan({ ...blankScan,  ...data.scan })
      setLoading(false)
    })
  }, [isAdmin])

  async function save(e) {
    e.preventDefault()
    setError(''); setSaved(false)
    const r = await api('/api/settings/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unifi, scan }),
    })
    if (!r.ok) { setError((await r.json()).detail || 'Save failed'); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    // Re-load to get masked password back
    const fresh = await (await api('/api/settings/')).json()
    if (fresh.unifi) setUnifi({ ...blankUnifi, ...fresh.unifi })
    if (fresh.scan)  setScan({ ...blankScan,   ...fresh.scan })
  }

  async function testUnifi() {
    setTesting(true); setTestResult(null)
    const r = await api('/api/unifi/clients')
    if (r.ok) {
      const clients = await r.json()
      setTestResult({ ok: true, msg: `Connected — ${clients.length} client(s) visible` })
    } else {
      const data = await r.json().catch(() => ({}))
      setTestResult({ ok: false, msg: data.detail || `HTTP ${r.status}` })
    }
    setTesting(false)
  }

  if (!isAdmin) return <div><h1>Settings</h1><p style={{ color: 'var(--text-muted)' }}>Admin access required.</p></div>
  if (loading)  return <div><h1>Settings</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  return (
    <div style={{ maxWidth: 600 }}>
      <h1>Settings</h1>

      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* ── UniFi ──────────────────────────────────────────────── */}
        <section className="card">
          <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>UniFi Controller</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
            Credentials are stored encrypted (AES-256 Fernet) using your SECRET_KEY.
          </p>

          <Field label="Controller URL" hint="e.g. https://192.168.1.1 or https://unifi.ui.com">
            <input value={unifi.url} onChange={e => setUnifi(u => ({ ...u, url: e.target.value }))}
              placeholder="https://192.168.1.1" />
          </Field>
          <Field label="Username">
            <input value={unifi.username} onChange={e => setUnifi(u => ({ ...u, username: e.target.value }))}
              autoComplete="off" />
          </Field>
          <Field label="Password" hint="Leave blank to keep existing">
            <input type="password" value={unifi.password}
              placeholder={unifi.password === MASK ? 'Saved — enter new to change' : ''}
              onChange={e => setUnifi(u => ({ ...u, password: e.target.value }))}
              autoComplete="new-password" />
          </Field>
          <Field label="Site" hint='Usually "default"'>
            <input value={unifi.site} onChange={e => setUnifi(u => ({ ...u, site: e.target.value }))} />
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14 }}>
            <input type="checkbox" checked={unifi.verify_ssl}
              onChange={e => setUnifi(u => ({ ...u, verify_ssl: e.target.checked }))} />
            Verify SSL certificate
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="secondary" onClick={testUnifi} disabled={testing || !unifi.url}>
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {testResult && (
              <span style={{ fontSize: 12, color: testResult.ok ? 'var(--green)' : 'var(--red)' }}>
                {testResult.ok ? '✓' : '✗'} {testResult.msg}
              </span>
            )}
          </div>
        </section>

        {/* ── Scan ───────────────────────────────────────────────── */}
        <section className="card">
          <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>Network Scan</h2>

          <Field label="Default CIDR" hint="Used as the pre-filled value on the Devices page">
            <input value={scan.default_cidr}
              onChange={e => setScan(s => ({ ...s, default_cidr: e.target.value }))}
              placeholder="192.168.1.0/24" />
          </Field>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14 }}>
            <input type="checkbox" checked={scan.auto_scan}
              onChange={e => setScan(s => ({ ...s, auto_scan: e.target.checked }))} />
            Auto-scan on startup &amp; schedule
          </label>

          {scan.auto_scan && (
            <Field label="Interval (minutes)">
              <input type="number" min={5} max={1440} value={scan.auto_scan_interval_minutes}
                onChange={e => setScan(s => ({ ...s, auto_scan_interval_minutes: +e.target.value }))}
                style={{ width: 100 }} />
            </Field>
          )}

          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 4px' }}>
            Auto-scan changes take effect after a container restart.
          </p>
        </section>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--red)', background: '#2e1a1a',
            border: '1px solid var(--red)', borderRadius: 6, padding: '8px 12px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="submit">Save Settings</button>
          {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Saved</span>}
        </div>
      </form>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}
        {hint && <span style={{ fontWeight: 400, marginLeft: 6 }}>— {hint}</span>}
      </span>
      {children}
    </label>
  )
}

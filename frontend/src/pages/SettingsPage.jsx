import React, { useEffect, useState } from 'react'
import { useAuth, useApi } from '../auth'

function useVersion() {
  const [version, setVersion] = useState('')
  useEffect(() => {
    fetch('/api/auth/version').then(r => r.ok ? r.json() : null).then(d => { if (d) setVersion(d.version) })
  }, [])
  return version
}

const MASK = '••••••••'

const blankUnifi   = { url: '', username: '', password: '', api_key: '', site: 'default', verify_ssl: false, controller_type: 'classic' }
const blankScan    = { default_cidr: '192.168.1.0/24', auto_scan: false, auto_scan_interval_minutes: 60 }
const blankOpenVas = { socket_path: '/var/run/gvmd/gvmd.sock', host: '', port: 9390, username: 'admin', password: '' }

export default function SettingsPage() {
  const { isAdmin } = useAuth()
  const api = useApi()
  const version = useVersion()
  const [unifi, setUnifi]       = useState(blankUnifi)
  const [scan, setScan]         = useState(blankScan)
  const [openvas, setOpenVas]   = useState(blankOpenVas)
  const [saved, setSaved]       = useState(false)
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(true)
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting]   = useState(false)
  const [ovTest, setOvTest]     = useState(null)
  const [ovTesting, setOvTesting] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    api('/api/settings/').then(r => r.json()).then(data => {
      if (data.unifi)   setUnifi({ ...blankUnifi, ...data.unifi })
      if (data.scan)    setScan({ ...blankScan, ...data.scan })
      if (data.openvas) setOpenVas({ ...blankOpenVas, ...data.openvas })
      setLoading(false)
    })
  }, [isAdmin])

  async function save(e) {
    e.preventDefault()
    setError(''); setSaved(false)
    const r = await api('/api/settings/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unifi, scan, openvas }),
    })
    if (!r.ok) { setError((await r.json()).detail || 'Save failed'); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    // Re-load to get masked passwords back
    const fresh = await (await api('/api/settings/')).json()
    if (fresh.unifi)   setUnifi({ ...blankUnifi, ...fresh.unifi })
    if (fresh.scan)    setScan({ ...blankScan, ...fresh.scan })
    if (fresh.openvas) setOpenVas({ ...blankOpenVas, ...fresh.openvas })
  }

  async function testOpenVas() {
    setOvTesting(true); setOvTest(null)
    const r = await api('/api/vuln-scan/health')
    const data = await r.json().catch(() => ({}))
    setOvTest(data.connected
      ? { ok: true,  msg: `Connected — GVM ${data.version}` }
      : { ok: false, msg: data.error || 'Could not connect' })
    setOvTesting(false)
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

          <Field label="Controller Type">
            <select value={unifi.controller_type} onChange={e => setUnifi(u => ({ ...u, controller_type: e.target.value }))}>
              <option value="classic">Classic (Network Application)</option>
              <option value="udm">Dream Machine (UDM / UDM-Pro)</option>
            </select>
          </Field>
          <Field label="Controller URL" hint="e.g. https://192.168.1.1 or https://192.168.1.1:8443">
            <input value={unifi.url} onChange={e => setUnifi(u => ({ ...u, url: e.target.value }))}
              placeholder="https://192.168.1.1" />
          </Field>
          <Field label="API Key" hint="Recommended — bypasses MFA. Leave blank to use username/password">
            <input type="password" value={unifi.api_key}
              placeholder={unifi.api_key === MASK ? 'Saved — enter new to change' : ''}
              onChange={e => setUnifi(u => ({ ...u, api_key: e.target.value }))}
              autoComplete="new-password" />
          </Field>
          <Field label="Username" hint="Only needed if not using API key">
            <input value={unifi.username} onChange={e => setUnifi(u => ({ ...u, username: e.target.value }))}
              autoComplete="off" />
          </Field>
          <Field label="Password" hint="Only needed if not using API key">
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

        {/* ── OpenVAS ────────────────────────────────────────────── */}
        <section className="card">
          <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15 }}>OpenVAS / Greenbone</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
            Vulnerability scanner powered by{' '}
            <a href="https://www.greenbone.net/" target="_blank" rel="noreferrer"
              style={{ color: 'var(--accent)' }}>Greenbone Community Edition</a>.
            Credentials stored encrypted. Connect via Unix socket (Docker) or TLS host.
          </p>

          <Field label="Unix Socket Path" hint="Docker: /var/run/gvmd/gvmd.sock — leave Host blank to use socket">
            <input value={openvas.socket_path}
              onChange={e => setOpenVas(o => ({ ...o, socket_path: e.target.value }))}
              placeholder="/var/run/gvmd/gvmd.sock" />
          </Field>
          <Field label="Host" hint="Override socket — e.g. 192.168.1.50 for remote GVM">
            <input value={openvas.host}
              onChange={e => setOpenVas(o => ({ ...o, host: e.target.value }))}
              placeholder="Leave blank to use socket" />
          </Field>
          <Field label="GMP Port" hint="Only used when Host is set">
            <input type="number" value={openvas.port}
              onChange={e => setOpenVas(o => ({ ...o, port: +e.target.value }))}
              style={{ width: 100 }} />
          </Field>
          <Field label="Username">
            <input value={openvas.username}
              onChange={e => setOpenVas(o => ({ ...o, username: e.target.value }))}
              autoComplete="off" />
          </Field>
          <Field label="Password" hint="Leave blank to keep existing">
            <input type="password" value={openvas.password}
              placeholder={openvas.password === MASK ? 'Saved — enter new to change' : ''}
              onChange={e => setOpenVas(o => ({ ...o, password: e.target.value }))}
              autoComplete="new-password" />
          </Field>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="secondary" onClick={testOpenVas} disabled={ovTesting}>
              {ovTesting ? 'Testing…' : 'Test Connection'}
            </button>
            {ovTest && (
              <span style={{ fontSize: 12, color: ovTest.ok ? 'var(--green)' : 'var(--red)' }}>
                {ovTest.ok ? '✓' : '✗'} {ovTest.msg}
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

      {/* ── About ── */}
      <section className="card" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0, marginBottom: 8, fontSize: 15 }}>About</h2>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          BaumLab{version && <span style={{ marginLeft: 8, fontFamily: 'monospace', color: 'var(--text)' }}>v{version}</span>}
        </div>
      </section>
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

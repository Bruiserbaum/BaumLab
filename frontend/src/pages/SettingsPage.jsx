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
const blankGitSync = { repo_url: '', branch: '', path: '', token: '', auto_sync: true }
const blankUpdates = { repo: '', portainer_connection: '', stack_id: null }
const blankRepoSource = { name: '', type: 'github', url: '', owner: '', token: '', orig_name: null }
const REPO_TYPES = [
  ['github', 'GitHub.com'],
  ['github-enterprise', 'GitHub Enterprise'],
  ['gitea', 'Gitea / Forgejo'],
]
const withOrigName = sources => (sources || []).map(s => ({ ...blankRepoSource, ...s, orig_name: s.name }))
const UPDATE_TIMEOUT_MS = 15 * 60_000

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
  const [gitSync, setGitSync]   = useState(blankGitSync)
  const [gitTest, setGitTest]   = useState(null)
  const [gitTesting, setGitTesting] = useState(false)
  const [updates, setUpdates]   = useState(blankUpdates)
  const [updStatus, setUpdStatus] = useState(null)
  const [updMsg, setUpdMsg]     = useState(null)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [connections, setConnections] = useState([])
  const [stacks, setStacks]     = useState([])
  const [repoSources, setRepoSources] = useState([])

  useEffect(() => {
    if (!isAdmin) return
    api('/api/settings/').then(r => r.json()).then(data => {
      if (data.unifi)   setUnifi({ ...blankUnifi, ...data.unifi })
      if (data.scan)    setScan({ ...blankScan, ...data.scan })
      if (data.openvas) setOpenVas({ ...blankOpenVas, ...data.openvas })
      if (data.git_sync) setGitSync({ ...blankGitSync, ...data.git_sync })
      setRepoSources(withOrigName(data.repo_sources))
      if (data.updates) {
        setUpdates({ ...blankUpdates, ...data.updates })
        if (data.updates.portainer_connection) loadStacks(data.updates.portainer_connection)
      }
      setLoading(false)
    })
    api('/api/updates/status').then(r => r.ok ? r.json() : null).then(setUpdStatus)
    api('/api/portainer/connections').then(r => r.ok ? r.json() : []).then(setConnections)
  }, [isAdmin])

  async function loadStacks(connection) {
    setStacks([])
    if (!connection) return
    const r = await api(`/api/updates/stacks?connection=${encodeURIComponent(connection)}`)
    const data = await r.json().catch(() => [])
    if (r.ok) setStacks(data)
    else setUpdMsg({ ok: false, msg: data.detail || `Could not list stacks (HTTP ${r.status})` })
  }

  async function checkUpdates() {
    setChecking(true); setUpdMsg(null)
    const r = await api('/api/updates/check', { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    if (r.ok) setUpdStatus(data)
    else setUpdMsg({ ok: false, msg: data.detail || `HTTP ${r.status}` })
    setChecking(false)
  }

  async function applyUpdate() {
    const tag = updStatus?.latest_tag
    if (!confirm(`Update BaumLab to ${tag}?\n\nPortainer will rebuild and restart the stack. BaumLab will be ` +
                 `unavailable for a few minutes while the images build.`)) return
    setApplying(true); setUpdMsg(null)
    // Save the update settings first so the backend uses what's on screen
    await api('/api/settings/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    })
    const r = await api('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { setUpdMsg({ ok: false, msg: data.detail || `HTTP ${r.status}` }); setApplying(false); return }

    setUpdMsg({ ok: true, msg: `Updating to ${tag} — Portainer is rebuilding. This page reloads when it's back.` })
    const target = tag.replace(/^v/, '')
    const started = Date.now()
    const poll = setInterval(async () => {
      if (Date.now() - started > UPDATE_TIMEOUT_MS) {
        clearInterval(poll); setApplying(false)
        setUpdMsg({ ok: false, msg: 'Still not on the new version after 15 minutes — check the stack in Portainer.' })
        return
      }
      try {
        const v = await (await fetch('/api/auth/version')).json()
        if (v.version === target) { clearInterval(poll); window.location.reload(); return }
        // Same container still answering — see if Portainer rejected the redeploy
        const s = await api('/api/updates/status')
        const st = s.ok ? await s.json() : null
        if (st?.update_error) {
          clearInterval(poll); setApplying(false); setUpdStatus(st)
          setUpdMsg({ ok: false, msg: st.update_error })
        }
      } catch { /* API restarting — keep waiting */ }
    }, 5000)
  }

  async function save(e) {
    e.preventDefault()
    setError(''); setSaved(false)
    const r = await api('/api/settings/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unifi, scan, openvas, git_sync: gitSync, updates, repo_sources: repoSources }),
    })
    if (!r.ok) { setError((await r.json()).detail || 'Save failed'); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    // Re-load to get masked passwords back
    const fresh = await (await api('/api/settings/')).json()
    if (fresh.unifi)   setUnifi({ ...blankUnifi, ...fresh.unifi })
    if (fresh.scan)    setScan({ ...blankScan, ...fresh.scan })
    if (fresh.openvas) setOpenVas({ ...blankOpenVas, ...fresh.openvas })
    if (fresh.git_sync) setGitSync({ ...blankGitSync, ...fresh.git_sync })
    setRepoSources(withOrigName(fresh.repo_sources))
  }

  async function testGitSync() {
    setGitTesting(true); setGitTest(null)
    const r = await api('/api/git-sync/test', { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    setGitTest(r.ok
      ? { ok: true,  msg: `Connected — ${data.repo} (${data.branch || 'default branch'})${data.empty ? ', empty repo' : ''}` }
      : { ok: false, msg: data.detail || `HTTP ${r.status}` })
    setGitTesting(false)
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

        {/* ── Git Sync ───────────────────────────────────────────── */}
        <section className="card">
          <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15 }}>Git Sync (Forgejo / Gitea)</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
            Commits the Services inventory to a repo as <code>README.md</code>, <code>services.yaml</code> and
            per-host pages. One-way — BaumLab overwrites those files. Token stored encrypted.
          </p>

          <Field label="Repository URL">
            <input value={gitSync.repo_url} placeholder="https://git.example.com/owner/infra-map"
              onChange={e => setGitSync(g => ({ ...g, repo_url: e.target.value }))} />
          </Field>
          <Field label="Access Token" hint="Forgejo → Settings → Applications, scope: repository (read & write)">
            <input type="password" value={gitSync.token}
              placeholder={gitSync.token === MASK ? 'Saved — enter new to change' : ''}
              onChange={e => setGitSync(g => ({ ...g, token: e.target.value }))}
              autoComplete="new-password" />
          </Field>
          <Field label="Branch" hint="Blank = repo default">
            <input value={gitSync.branch} placeholder="main" style={{ width: 160 }}
              onChange={e => setGitSync(g => ({ ...g, branch: e.target.value }))} />
          </Field>
          <Field label="Folder" hint="Blank = repo root">
            <input value={gitSync.path} placeholder="services" style={{ width: 160 }}
              onChange={e => setGitSync(g => ({ ...g, path: e.target.value }))} />
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14 }}>
            <input type="checkbox" checked={gitSync.auto_sync}
              onChange={e => setGitSync(g => ({ ...g, auto_sync: e.target.checked }))} />
            Auto-sync after each change (edits within 30 s are batched into one commit)
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="secondary" onClick={testGitSync} disabled={gitTesting}>
              {gitTesting ? 'Testing…' : 'Test Connection'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Uses saved settings — save first.</span>
            {gitTest && (
              <span style={{ fontSize: 12, color: gitTest.ok ? 'var(--green)' : 'var(--red)' }}>
                {gitTest.ok ? '✓' : '✗'} {gitTest.msg}
              </span>
            )}
          </div>
        </section>

        {/* ── Repository sources ─────────────────────────────────── */}
        <section className="card">
          <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15 }}>Repository Sources</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
            Git hosts shown on the Repositories page. Use a read-only token — it lists everything the token
            can see, private repos included. Without a token, set an owner to list their public repos.
          </p>

          {repoSources.map((s, i) => {
            const set = patch => setRepoSources(list => list.map((x, j) => j === i ? { ...x, ...patch } : x))
            return (
              <div key={i} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Field label="Name">
                    <input value={s.name} placeholder="GitHub" onChange={e => set({ name: e.target.value })} />
                  </Field>
                  <Field label="Type">
                    <select value={s.type} onChange={e => set({ type: e.target.value })}>
                      {REPO_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                  </Field>
                </div>
                {s.type !== 'github' && (
                  <Field label="Base URL">
                    <input value={s.url} placeholder={s.type === 'gitea' ? 'https://git.example.com' : 'https://github.example.com'}
                      onChange={e => set({ url: e.target.value })} />
                  </Field>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Field label="Owner" hint="optional filter">
                    <input value={s.owner} placeholder="user or org" onChange={e => set({ owner: e.target.value })} />
                  </Field>
                  <Field label="Token" hint={s.type === 'gitea' ? 'scope: read repository' : 'fine-grained, read-only'}>
                    <input type="password" value={s.token} autoComplete="new-password"
                      placeholder={s.token === MASK ? 'Saved — enter new to change' : ''}
                      onChange={e => set({ token: e.target.value })} />
                  </Field>
                </div>
                <button type="button" className="secondary" style={{ color: 'var(--red)' }}
                  onClick={() => setRepoSources(list => list.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            )
          })}
          <button type="button" className="secondary"
            onClick={() => setRepoSources(list => [...list, { ...blankRepoSource }])}>
            + Add source
          </button>
        </section>

        {/* ── Updates ────────────────────────────────────────────── */}
        <section className="card">
          <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15 }}>Updates</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
            Checks GitHub release tags every 6 hours. Applying an update asks Portainer to redeploy
            BaumLab's Git stack at the new tag — it rebuilds and restarts itself. Requires the stack to be
            deployed from Git in Portainer, and a Portainer connection on the Docker page.
          </p>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 14, fontSize: 13, flexWrap: 'wrap' }}>
            <span>Running <b style={{ fontFamily: 'monospace' }}>v{updStatus?.current ?? version}</b></span>
            {updStatus?.latest && (
              <span style={{ color: updStatus.update_available ? 'var(--yellow)' : 'var(--green)' }}>
                {updStatus.update_available ? `↑ ${updStatus.latest_tag} available` : '✓ Up to date'}
              </span>
            )}
            {updStatus?.check_error && <span style={{ color: 'var(--red)', fontSize: 12 }}>✗ {updStatus.check_error}</span>}
            <button type="button" className="secondary" onClick={checkUpdates} disabled={checking}>
              {checking ? 'Checking…' : 'Check Now'}
            </button>
          </div>

          <Field label="GitHub Repository" hint="Blank = Bruiserbaum/BaumLab; set your fork's owner/repo">
            <input value={updates.repo} placeholder="Bruiserbaum/BaumLab"
              onChange={e => setUpdates(u => ({ ...u, repo: e.target.value }))} />
          </Field>
          <Field label="Portainer Connection">
            <select value={updates.portainer_connection}
              onChange={e => {
                const name = e.target.value
                setUpdates(u => ({ ...u, portainer_connection: name, stack_id: null }))
                loadStacks(name)
              }}>
              <option value="">— choose —</option>
              {connections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="BaumLab Stack">
            <select value={updates.stack_id ?? ''} disabled={!updates.portainer_connection}
              onChange={e => setUpdates(u => ({ ...u, stack_id: e.target.value ? +e.target.value : null }))}>
              <option value="">— choose —</option>
              {stacks.map(s => (
                <option key={s.id} value={s.id} disabled={!s.git_url}>
                  {s.name}{s.git_url ? ` — ${s.git_url.replace(/^https?:\/\//, '')} @ ${s.reference || 'default'}` : ' (not from Git)'}
                </option>
              ))}
            </select>
          </Field>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={applyUpdate}
              disabled={applying || !updStatus?.update_available || !updates.portainer_connection || !updates.stack_id}>
              {applying ? 'Updating…' : `Apply Update${updStatus?.update_available ? ` (${updStatus.latest_tag})` : ''}`}
            </button>
            {updMsg && (
              <span style={{ fontSize: 12, color: updMsg.ok ? 'var(--green)' : 'var(--red)' }}>
                {updMsg.ok ? '⟳' : '✗'} {updMsg.msg}
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

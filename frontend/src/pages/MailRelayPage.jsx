import React, { useEffect, useState } from 'react'
import { useApi, useAuth } from '../auth'

const API = '/api/mail-relay'
const MASK = '••••••••'

// Upstream presets: fill host / port / security (and the username where it's fixed)
const PRESETS = {
  custom: { label: 'Other / my own mail server' },
  gmail: { label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls',
    hint: 'Username = your Gmail address. Password = an app password (Google Account → Security → App passwords; needs 2-step verification). Gmail only sends as your own address or an alias added in Gmail, so set “Send as” to that.' },
  outlook: { label: 'Outlook.com / Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls',
    hint: 'Outlook.com needs an app password. Microsoft 365 needs “Authenticated SMTP” turned on for the mailbox. Send as the mailbox address.' },
  icloud: { label: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, security: 'starttls',
    hint: 'Username = your iCloud email address. Password = an app-specific password from account.apple.com.' },
  fastmail: { label: 'Fastmail', host: 'smtp.fastmail.com', port: 465, security: 'ssl',
    hint: 'Use an app password (Settings → Privacy & Security → Manage app passwords).' },
  zoho: { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, security: 'ssl', hint: 'Use an app-specific password if two-factor sign-in is on.' },
  sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, security: 'starttls', username: 'apikey',
    hint: 'Username is literally “apikey”; the password is your API key. Send as an address on a verified sender or domain.' },
  mailgun: { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, security: 'starttls',
    hint: 'SMTP credentials from your Mailgun domain settings. EU accounts use smtp.eu.mailgun.org.' },
  ses: { label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, security: 'starttls',
    hint: 'Change the region in the host to yours, and use SES SMTP credentials (not your AWS access keys). Send as a verified address or domain.' },
  brevo: { label: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls',
    hint: 'Login = your Brevo SMTP login; password = an SMTP key.' },
}
const STATUS_BADGE = { sent: 'green', queued: 'blue', deferred: 'yellow', failed: 'red', rejected: 'gray' }
const STATUS_LABEL = { sent: 'Sent', queued: 'Queued', deferred: 'Retrying', failed: 'Failed', rejected: 'Refused' }

const utc = v => v ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : v + 'Z') : null

function Field({ label, hint, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, flex: 1, minWidth: 160, ...style }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}{hint && <span style={{ marginLeft: 6, fontWeight: 400 }}>— {hint}</span>}</span>
      {children}
    </label>
  )
}

function Card({ title, sub, children }) {
  return (
    <section className="card">
      <h2 style={{ marginTop: 0, marginBottom: sub ? 4 : 12, fontSize: 15, color: 'var(--text)' }}>{title}</h2>
      {sub && <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>{sub}</p>}
      {children}
    </section>
  )
}

function newPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, b => chars[b % chars.length]).join('')
}

// What a device's mail will look like once it leaves the relay
function preview(cfg) {
  const device = { name: 'Proxmox', addr: 'root@pve.local', local: 'root' }
  const fill = s => (s || '').replace(/\{(\w+)\}/g, (_, k) => ({ name: device.name, local: device.local, login: 'nas', ip: '192.168.1.20', helo: 'pve' }[k] ?? ''))
  const domain = device.addr.split('@')[1]
  const rewrite = cfg.from_address && (cfg.from_mode === 'rewrite' || (cfg.from_mode === 'keep_domains' && !cfg.keep_domains.includes(domain)))
  if (!rewrite) return `“${device.name}” <${device.addr}> goes out unchanged`
  const name = fill(cfg.from_name)
  return `“${device.name}” <${device.addr}> goes out as ${name ? `“${name}” ` : ''}<${fill(cfg.from_address)}>` +
    (cfg.reply_to_original ? `, replies going to ${device.addr}` : '')
}

function StatusCard({ status }) {
  if (!status) return null
  const c = status.last_24h || {}
  const state = !status.listening ? ['red', 'Not listening'] : !status.enabled ? ['gray', 'Turned off'] : !status.configured ? ['yellow', 'No upstream yet'] : ['green', 'Ready']
  return (
    <Card title="Point your devices at">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div>SMTP server: <code>{status.hostname}</code> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>(or BaumLab's IP address)</span></div>
          <div>Port: <code>{status.port}</code></div>
          <div>Security / encryption: <code>None</code></div>
          <div>Login: <span style={{ color: 'var(--text-muted)' }}>only if you turned on “require a login” below</span></div>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div><span className={`badge badge-${state[0]}`}>{state[1]}</span></div>
          {status.error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{status.error}</div>}
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Last 24 h: {c.sent || 0} sent · {status.queued} waiting · {c.failed || 0} failed · {c.rejected || 0} refused
          </div>
          {status.upstream && (
            <div style={{ fontSize: 12, color: status.upstream.ok ? 'var(--green)' : 'var(--red)' }}>
              {status.upstream.ok ? '✓ Upstream reachable' : `✗ Upstream: ${status.upstream.error}`}
              <span style={{ color: 'var(--text-muted)' }}> ({utc(status.upstream.at)?.toLocaleTimeString()})</span>
            </div>
          )}
        </div>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
        To use the name above, add a DNS record for it (router or Pi-hole / AdGuard local DNS) pointing at the machine BaumLab runs on.
        A device that only offers port 25: set <code>SMTP_RELAY_PORT=25</code> in the stack's environment and redeploy.
      </p>
    </Card>
  )
}

function Messages({ api, rows, reload }) {
  const [filter, setFilter] = useState('')
  const shown = filter ? rows.filter(r => r.status === filter) : rows

  async function act(r, how) {
    if (how === 'delete' && !confirm('Delete this message from the log (and its stored copy)?')) return
    await api(`${API}/messages/${r.id}${how === 'retry' ? '/retry' : ''}`, { method: how === 'retry' ? 'POST' : 'DELETE' })
    reload()
  }
  async function download(r) {
    const res = await api(`${API}/messages/${r.id}/eml`)
    if (!res.ok) return alert('The stored copy of this message is gone')
    const url = URL.createObjectURL(await res.blob())
    Object.assign(document.createElement('a'), { href: url, download: `relay-message-${r.id}.eml` }).click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '24px 0 12px' }}>
        <h2 style={{ margin: 0 }}>Messages</h2>
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="secondary" onClick={reload}>↻</button>
      </div>
      {shown.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Nothing yet — messages and refused attempts show up here.</div>
      ) : (
        <table>
          <thead><tr><th>When</th><th>From → To</th><th>Subject</th><th>Device</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.id}>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{utc(r.received_at).toLocaleString()}</td>
                <td style={{ fontSize: 12 }}>
                  <div>{r.mail_from || <span style={{ color: 'var(--text-muted)' }}>(empty sender)</span>}{r.sent_from && r.sent_from !== r.mail_from && <span style={{ color: 'var(--text-muted)' }}> → sent as {r.sent_from}</span>}</div>
                  <div style={{ color: 'var(--text-muted)' }}>to {(r.sent_to || r.rcpt_to).join(', ') || '—'}</div>
                </td>
                <td style={{ fontSize: 12 }}>{r.subject || (r.status === 'rejected' ? '' : <span style={{ color: 'var(--text-muted)' }}>(no subject)</span>)}</td>
                <td style={{ fontSize: 12 }}>
                  <div>{r.client_ip}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{[r.helo, r.login && `login ${r.login}`].filter(Boolean).join(' · ')}</div>
                </td>
                <td style={{ fontSize: 12, maxWidth: 340 }}>
                  <span className={`badge badge-${STATUS_BADGE[r.status] ?? 'gray'}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.attempts > 1 && <span style={{ color: 'var(--text-muted)' }}> {r.attempts} tries</span>}
                  {r.status === 'deferred' && r.next_attempt_at && <span style={{ color: 'var(--text-muted)' }}> · next {utc(r.next_attempt_at).toLocaleTimeString()}</span>}
                  {r.last_error && <div style={{ color: r.status === 'sent' ? 'var(--yellow)' : r.status === 'rejected' ? 'var(--text-muted)' : 'var(--red)' }}>{r.last_error}</div>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.stored && ['failed', 'deferred', 'sent'].includes(r.status) && (
                      <button className="secondary" onClick={() => act(r, 'retry')} title={r.status === 'sent' ? 'Send again' : 'Try now'}>↻</button>
                    )}
                    {r.stored && <button className="secondary" onClick={() => download(r)} title="Download the message as the device sent it (.eml)">⤓</button>}
                    <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => act(r, 'delete')}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

export default function MailRelayPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [cfg, setCfg] = useState(null)
  const [status, setStatus] = useState(null)
  const [rows, setRows] = useState([])
  const [entries, setEntries] = useState([])
  const [notice, setNotice] = useState(null)
  const [upTest, setUpTest] = useState(null)
  const [testTo, setTestTo] = useState('')
  const [networksText, setNetworksText] = useState('')
  const [domainsText, setDomainsText] = useState('')

  async function loadConfig() {
    const r = await api(`${API}/config`)
    if (!r.ok) return
    const c = await r.json()
    setCfg(c)
    setNetworksText(c.allowed_networks.join('\n'))
    setDomainsText(c.keep_domains.join(', '))
  }
  async function loadLive() {
    const [s, m] = await Promise.all([api(`${API}/status`), api(`${API}/messages?limit=200`)])
    if (s.ok) setStatus(await s.json())
    if (m.ok) setRows(await m.json())
  }
  useEffect(() => {
    if (!isAdmin) return
    loadConfig(); loadLive()
    api('/api/vault/').then(r => r.ok ? r.json() : []).then(setEntries).catch(() => {})
    const t = setInterval(loadLive, 10000)
    return () => clearInterval(t)
  }, [isAdmin])

  if (!isAdmin) return <div><h1>Mail relay</h1><p style={{ color: 'var(--text-muted)' }}>Admin access required.</p></div>
  if (!cfg) return <div><h1>Mail relay</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const set = patch => setCfg(c => ({ ...c, ...patch }))
  const setUp = patch => setCfg(c => ({ ...c, upstream: { ...c.upstream, ...patch } }))
  const setLogin = (i, patch) => setCfg(c => ({ ...c, logins: c.logins.map((l, j) => j === i ? { ...l, ...patch } : l) }))
  const preset = PRESETS[cfg.upstream.preset] ?? PRESETS.custom
  const fromVault = cfg.upstream.credential_id != null && cfg.upstream.credential_id !== ''
  const flash = (ok, text) => { setNotice({ ok, text }); setTimeout(() => setNotice(null), 5000) }

  function choosePreset(key) {
    const p = PRESETS[key]
    setUp({ preset: key, ...(p.host ? { host: p.host, port: p.port, security: p.security } : {}), ...(p.username ? { username: p.username } : {}) })
  }

  async function save() {
    const body = {
      ...cfg,
      allowed_networks: networksText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
      keep_domains: domainsText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
    }
    const r = await api(`${API}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { flash(false, typeof data.detail === 'string' ? data.detail : `HTTP ${r.status}`); return false }
    setCfg(data); setNetworksText(data.allowed_networks.join('\n')); setDomainsText(data.keep_domains.join(', '))
    flash(true, 'Saved'); loadLive()
    return true
  }

  async function testUpstream() {
    if (!(await save())) return
    setUpTest({ ok: true, message: 'Connecting…' })
    const r = await api(`${API}/test-upstream`, { method: 'POST' })
    setUpTest(await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` })))
  }

  async function sendTest() {
    const r = await api(`${API}/test-send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: testTo }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return flash(false, data.detail || `HTTP ${r.status}`)
    flash(true, 'Test queued — watch its status in Messages below')
    setTimeout(loadLive, 2500)
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1>Mail relay</h1>
      <p style={{ marginTop: -8, fontSize: 13, color: 'var(--text-muted)' }}>
        Devices and apps on your network send their alert emails here; BaumLab passes them on through one mail account.
        Nothing is lost while that account is unreachable — messages wait and are retried.
      </p>

      <StatusCard status={status} />

      <Card title="Relay">
        <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 12 }}>
          <input type="checkbox" checked={cfg.enabled} onChange={e => set({ enabled: e.target.checked })} />
          Accept mail from devices
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Field label="Relay name" hint="what devices connect to, e.g. smtp.home.lan">
            <input value={cfg.hostname} onChange={e => set({ hostname: e.target.value })} />
          </Field>
          <Field label="Largest message (MB)" style={{ maxWidth: 170 }}>
            <input type="number" min={1} max={100} value={cfg.max_size_mb} onChange={e => set({ max_size_mb: +e.target.value })} />
          </Field>
          <Field label="Keep the log for (days)" style={{ maxWidth: 170 }}>
            <input type="number" min={1} value={cfg.retention_days} onChange={e => set({ retention_days: +e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card title="Send through" sub="The mail account BaumLab hands every message to.">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Field label="Provider">
            <select value={cfg.upstream.preset || 'custom'} onChange={e => choosePreset(e.target.value)}>
              {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="SMTP host"><input value={cfg.upstream.host} placeholder="smtp.example.com" onChange={e => setUp({ host: e.target.value })} /></Field>
          <Field label="Port" style={{ maxWidth: 110 }}><input type="number" value={cfg.upstream.port} onChange={e => setUp({ port: +e.target.value })} /></Field>
          <Field label="Security" style={{ maxWidth: 190 }}>
            <select value={cfg.upstream.security} onChange={e => setUp({ security: e.target.value })}>
              <option value="starttls">STARTTLS (587)</option>
              <option value="ssl">SSL/TLS (465)</option>
              <option value="none">None</option>
            </select>
          </Field>
        </div>
        {preset.hint && <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text-muted)' }}>{preset.hint}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Field label="Username" hint={fromVault ? "blank = the vault entry's username" : ''}>
            <input value={cfg.upstream.username} autoComplete="off" onChange={e => setUp({ username: e.target.value })} />
          </Field>
          <Field label="Where the password is kept">
            <select value={cfg.upstream.credential_id ?? ''} onChange={e => setUp({ credential_id: e.target.value === '' ? null : +e.target.value })}>
              <option value="">Typed here (stored encrypted)</option>
              {entries.map(v => <option key={v.id} value={v.id}>🔒 Vault: {v.title}{v.username ? ` (${v.username})` : ''}</option>)}
            </select>
          </Field>
          {!fromVault && (
            <Field label="Password" hint={cfg.upstream.password === MASK ? 'saved — blank keeps it' : 'app password / API key'}>
              <input type="password" autoComplete="new-password" value={cfg.upstream.password === MASK ? '' : cfg.upstream.password}
                placeholder={cfg.upstream.password === MASK ? MASK : ''}
                onChange={e => setUp({ password: e.target.value === '' && cfg.upstream.password === MASK ? MASK : e.target.value })} />
            </Field>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="secondary" onClick={testUpstream}>Save &amp; test login</button>
          {upTest && <span style={{ fontSize: 12, color: upTest.ok ? 'var(--green)' : 'var(--red)' }}>{upTest.ok ? '✓' : '✗'} {upTest.message}</span>}
        </div>
      </Card>

      <Card title="How the sender looks" sub="Most providers only send as your own account's address, so a device's own sender usually has to be replaced.">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Field label="Sender">
            <select value={cfg.from_mode} onChange={e => set({ from_mode: e.target.value })}>
              <option value="rewrite">Always send as the address below</option>
              <option value="keep_domains">Send as the address below, unless the device already uses one of my domains</option>
              <option value="keep">Keep each device's own address</option>
            </select>
          </Field>
          {cfg.from_mode !== 'keep' && (
            <Field label="Send as" hint="e.g. alerts@example.com — or {local}@example.com to keep each device's name">
              <input value={cfg.from_address} placeholder="alerts@example.com" onChange={e => set({ from_address: e.target.value })} />
            </Field>
          )}
        </div>
        {cfg.from_mode !== 'keep' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Field label="Display name" hint="{name} = the device's own name; also {local}, {login}, {ip}">
              <input value={cfg.from_name} placeholder="{name} via BaumLab" onChange={e => set({ from_name: e.target.value })} />
            </Field>
            {cfg.from_mode === 'keep_domains' && (
              <Field label="My domains" hint="comma separated">
                <input value={domainsText} placeholder="example.com" onChange={e => setDomainsText(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        {cfg.from_mode !== 'keep' && (
          <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 10 }}>
            <input type="checkbox" checked={cfg.reply_to_original} onChange={e => set({ reply_to_original: e.target.checked })} />
            Replies go to the device's own address (Reply-To)
          </label>
        )}
        <Field label="Deliver everything to" hint="optional — ignore the recipients devices give and send all mail here (comma separated)">
          <input value={cfg.deliver_to} placeholder="you@example.com" onChange={e => set({ deliver_to: e.target.value })} />
        </Field>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>Example: {preview({ ...cfg, keep_domains: domainsText.split(/[\s,]+/).filter(Boolean) })}</p>
      </Card>

      <Card title="Who can send" sub="Only these networks are accepted. The defaults are the private ranges — every device on a home network.">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Field label="Allowed networks" hint="one per line — a range (192.168.1.0/24) or one address" style={{ maxWidth: 320 }}>
            <textarea rows={6} value={networksText} onChange={e => setNetworksText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Field>
          <div style={{ flex: 2, minWidth: 320 }}>
            <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={cfg.require_auth} onChange={e => set({ require_auth: e.target.checked })} />
              Also require a login
            </label>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
              Logins are optional unless required — a device that has one shows by name in the log. They're sent unencrypted, so keep them for this relay only.
            </p>
            {cfg.logins.map((l, i) => (
              <div key={l.id || `new-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Device"><input value={l.name} placeholder="NAS" onChange={e => setLogin(i, { name: e.target.value })} /></Field>
                <Field label="Username"><input value={l.username} autoComplete="off" onChange={e => setLogin(i, { username: e.target.value })} /></Field>
                <Field label="Password" hint={l.password === MASK ? 'saved' : ''}>
                  <input type={l.password === MASK ? 'password' : 'text'} autoComplete="new-password"
                    value={l.password === MASK ? '' : l.password} placeholder={l.password === MASK ? MASK : ''}
                    onChange={e => setLogin(i, { password: e.target.value === '' && l.password === MASK ? MASK : e.target.value })} />
                </Field>
                <button type="button" className="secondary" style={{ marginBottom: 10 }} title="New random password" onClick={() => setLogin(i, { password: newPassword() })}>⟳</button>
                <button type="button" className="secondary" style={{ marginBottom: 10, color: 'var(--red)' }}
                  onClick={() => setCfg(c => ({ ...c, logins: c.logins.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <button type="button" className="secondary" onClick={() => setCfg(c => ({ ...c, logins: [...c.logins, { name: '', username: '', password: newPassword() }] }))}>
              + Add login
            </button>
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={save}>Save mail relay settings</button>
        {notice && <span style={{ fontSize: 12, color: notice.ok ? 'var(--green)' : 'var(--red)' }}>{notice.ok ? '✓' : '✗'} {notice.text}</span>}
      </div>

      <Card title="Send a test" sub="Goes through the whole relay — queue, sender rewriting and the upstream account — like a device's mail would.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={testTo} placeholder="you@example.com" onChange={e => setTestTo(e.target.value)} style={{ maxWidth: 320 }} />
          <button className="secondary" onClick={sendTest} disabled={!testTo.includes('@')}>Send test</button>
        </div>
      </Card>

      <Messages api={api} rows={rows} reload={loadLive} />
    </div>
  )
}

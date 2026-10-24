import React, { useState } from 'react'
import { useApi, useAuth } from '../auth'

const API = '/api'

// ── Browser-side generators (crypto.getRandomValues, unbiased) ──────────────────

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
// No $ ` " ' \ or spaces — those break .env files, shells and docker-compose interpolation
const DB_CHARS = ALNUM + '-_.!@#%^*+='

function randomChars(alphabet, length) {
  const out = []
  const limit = 256 - (256 % alphabet.length)   // reject bytes that would bias the modulo
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(alphabet[b % alphabet.length])
    }
  }
  return out.join('')
}

const randomBytes = n => crypto.getRandomValues(new Uint8Array(n))
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function uuid4() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = toHex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const KEY_TYPES = [
  { id: 'hex32',  label: 'General secret (hex-32)', use: 'SECRET_KEY, APP_SECRET — same as openssl rand -hex 32', gen: () => toHex(randomBytes(32)) },
  { id: 'b64',    label: 'General secret (base64url)', use: 'Keys that must be base64, 32 bytes, no padding', gen: () => toBase64Url(randomBytes(32)) },
  { id: 'jwt',    label: 'JWT secret (hex-48)', use: 'HS256/HS512 signing secrets', gen: () => toHex(randomBytes(48)) },
  { id: 'db',     label: 'Database password', use: 'MySQL / PostgreSQL / MariaDB — 24 chars, compose-safe', gen: () => randomChars(DB_CHARS, 24) },
  { id: 'alnum',  label: 'Alphanumeric key', use: 'API keys, app tokens — 40 chars A-Z a-z 0-9', gen: () => randomChars(ALNUM, 40) },
  { id: 'uuid',   label: 'UUID v4', use: 'IDs, client IDs', gen: uuid4 },
]

// ── Small shared pieces ────────────────────────────────────────────────────────

function Copy({ value }) {
  const [done, setDone] = useState(false)
  async function copy() {
    if (!navigator.clipboard) { alert('Clipboard needs HTTPS — select the text and copy it manually'); return }
    await navigator.clipboard.writeText(value)
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return <button type="button" className="secondary" style={{ padding: '2px 8px' }} onClick={copy}>{done ? '✓' : '📋'}</button>
}

function Output({ label, value }) {
  if (!value) return null
  return (
    <div style={{ marginTop: 8 }}>
      {label && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <code style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '6px 10px', fontSize: 12, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{value}</code>
        <Copy value={value} />
      </div>
    </div>
  )
}

/** Inline "save this to the vault" control — admin only, purpose required (like BaumKeyGenerator). */
function SaveToVault({ secret, notes, username, defaultTitle = '' }) {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle)
  const [msg, setMsg] = useState(null)
  if (!isAdmin || !secret) return null

  async function save(e) {
    e.preventDefault()
    const r = await api(`${API}/vault/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), secret, notes: notes || null, username: username || null }),
    })
    const data = await r.json().catch(() => ({}))
    setMsg(r.ok ? { ok: true, text: 'Saved to vault' } : { ok: false, text: data.detail || `HTTP ${r.status}` })
    if (r.ok) setOpen(false)
  }

  return (
    <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {open ? (
        <form onSubmit={save} style={{ display: 'flex', gap: 6 }}>
          <input required autoFocus placeholder="Purpose, e.g. Nextcloud SECRET_KEY" value={title}
            style={{ width: 260 }} onChange={e => setTitle(e.target.value)} />
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => { setOpen(true); setMsg(null) }}>🔒 Save to Vault</button>
      )}
      {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.ok ? '✓' : '✗'} {msg.text}</span>}
    </div>
  )
}

function Card({ title, children, hint }) {
  return (
    <section className="card">
      <h2 style={{ marginTop: 0, marginBottom: hint ? 4 : 12, fontSize: 15, color: 'var(--text)' }}>{title}</h2>
      {hint && <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>{hint}</p>}
      {children}
    </section>
  )
}

// ── Tools ──────────────────────────────────────────────────────────────────────

function SecretKeys() {
  const [values, setValues] = useState({})
  return (
    <Card title="Secret keys" hint="Generated in your browser with cryptographically secure randomness — nothing is sent to the server unless you save it to the vault.">
      {KEY_TYPES.map(t => (
        <div key={t.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.use}</div>
            </div>
            <button type="button" onClick={() => setValues(v => ({ ...v, [t.id]: t.gen() }))}>Generate</button>
          </div>
          <Output value={values[t.id]} />
          <SaveToVault secret={values[t.id]} notes={`Generated in BaumLab Tools: ${t.label}`} />
        </div>
      ))}
    </Card>
  )
}

function VaultwardenToken() {
  const api = useApi()
  const [password, setPassword] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  async function generate() {
    setBusy(true)
    const r = await api(`${API}/tools/vaultwarden-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password || null }),
    })
    if (r.ok) setResult(await r.json())
    setBusy(false)
  }

  return (
    <Card title="Vaultwarden admin token" hint="Argon2id (m=65540, t=3, p=4 — the OWASP preset). Put the PHC string in ADMIN_TOKEN; log in to /admin with the password.">
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="password" placeholder="Password (blank = generate one)" value={password} autoComplete="new-password"
          style={{ flex: 1 }} onChange={e => setPassword(e.target.value)} />
        <button type="button" onClick={generate} disabled={busy}>{busy ? 'Hashing…' : 'Generate'}</button>
      </div>
      {result && <>
        <Output label="Admin panel password" value={result.password} />
        <Output label="ADMIN_TOKEN (.env / Portainer env var)" value={result.phc} />
        <Output label="ADMIN_TOKEN written directly in docker-compose.yml ($ escaped)" value={result.phc_compose} />
        <SaveToVault secret={result.password} notes={`ADMIN_TOKEN:\n${result.phc}`} defaultTitle="Vaultwarden admin" />
      </>}
    </Card>
  )
}

function Htpasswd() {
  const api = useApi()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [result, setResult] = useState(null)

  async function generate(e) {
    e.preventDefault()
    const r = await api(`${API}/tools/htpasswd`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: password || null }),
    })
    if (r.ok) setResult(await r.json())
  }

  return (
    <Card title="htpasswd (bcrypt)" hint="Basic-auth lines for NPM access lists, Traefik basicauth middleware and nginx auth_basic.">
      <form onSubmit={generate} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input required placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
        <input type="password" placeholder="Password (blank = generate)" value={password} autoComplete="new-password"
          style={{ flex: 1 }} onChange={e => setPassword(e.target.value)} />
        <button type="submit">Generate</button>
      </form>
      {result && <>
        <Output label="Password" value={result.password} />
        <Output label="htpasswd line" value={result.line} />
        <Output label="For docker-compose labels ($ escaped)" value={result.line_compose} />
        <SaveToVault secret={result.password} username={username} notes={result.line} />
      </>}
    </Card>
  )
}

function WireGuard() {
  const api = useApi()
  const [keys, setKeys] = useState(null)
  async function generate() {
    const r = await api(`${API}/tools/wireguard`, { method: 'POST' })
    if (r.ok) setKeys(await r.json())
  }
  return (
    <Card title="WireGuard keys" hint="Curve25519 keypair plus an optional preshared key — same format as wg genkey / wg pubkey / wg genpsk.">
      <button type="button" onClick={generate}>Generate keypair</button>
      {keys && <>
        <Output label="PrivateKey" value={keys.private_key} />
        <Output label="PublicKey" value={keys.public_key} />
        <Output label="PresharedKey (optional)" value={keys.preshared_key} />
        <SaveToVault secret={keys.private_key}
          notes={`PublicKey: ${keys.public_key}\nPresharedKey: ${keys.preshared_key}`} defaultTitle="WireGuard peer" />
      </>}
    </Card>
  )
}

function ipToInt(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}
const intToIp = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.')

function SubnetCalc() {
  const [cidr, setCidr] = useState('192.168.1.0/24')
  const [ip, bitsStr] = cidr.trim().split('/')
  const bits = bitsStr === undefined ? 32 : Number(bitsStr)
  const addr = ipToInt(ip || '')
  const valid = addr !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32

  let rows = []
  if (valid) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    const network = (addr & mask) >>> 0
    const broadcast = (network | (~mask >>> 0)) >>> 0
    const hosts = bits >= 31 ? 2 ** (32 - bits) : 2 ** (32 - bits) - 2
    rows = [
      ['Network', `${intToIp(network)}/${bits}`],
      ['Netmask', intToIp(mask)],
      ['Wildcard', intToIp(~mask >>> 0)],
      ['Broadcast', bits >= 31 ? '—' : intToIp(broadcast)],
      ['Usable hosts', bits >= 31 ? `${intToIp(network)} – ${intToIp(broadcast)}` : `${intToIp(network + 1)} – ${intToIp(broadcast - 1)}`],
      ['Host count', hosts.toLocaleString()],
    ]
  }

  return (
    <Card title="Subnet calculator">
      <input value={cidr} onChange={e => setCidr(e.target.value)} placeholder="10.0.20.0/24"
        style={{ width: 220, fontFamily: 'monospace' }} />
      {!valid && cidr && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>Enter an IPv4 address or CIDR, e.g. 10.0.20.0/24</div>}
      {valid && (
        <table style={{ marginTop: 10, maxWidth: 420 }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td style={{ color: 'var(--text-muted)', width: 130 }}>{k}</td><td style={{ fontFamily: 'monospace' }}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function b64UrlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))
}

function Decoder() {
  const [input, setInput] = useState('')
  let output = '', error = ''
  const text = input.trim()
  if (text) {
    try {
      const parts = text.split('.')
      if (parts.length === 3 && parts[0].startsWith('eyJ')) {
        const header = JSON.parse(b64UrlDecode(parts[0]))
        const payload = JSON.parse(b64UrlDecode(parts[1]))
        const times = ['exp', 'iat', 'nbf'].filter(k => typeof payload[k] === 'number')
          .map(k => `${k}: ${new Date(payload[k] * 1000).toLocaleString()}`).join('\n')
        output = `JWT header\n${JSON.stringify(header, null, 2)}\n\nPayload\n${JSON.stringify(payload, null, 2)}` +
                 (times ? `\n\n${times}` : '') + '\n\n(signature not verified)'
      } else {
        output = b64UrlDecode(text)
      }
    } catch {
      error = 'Not valid base64 or a JWT'
    }
  }
  return (
    <Card title="Base64 / JWT decoder" hint="Decodes locally in your browser. Paste a base64 string or a JWT.">
      <textarea value={input} onChange={e => setInput(e.target.value)} rows={3} placeholder="eyJhbGciOi… or SGVsbG8="
        style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace', fontSize: 12 }} />
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      <Output value={output} />
    </Card>
  )
}

export default function ToolsPage() {
  return (
    <div>
      <h1>Tools</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
        <SecretKeys />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <VaultwardenToken />
          <Htpasswd />
          <WireGuard />
        </div>
        <SubnetCalc />
        <Decoder />
      </div>
    </div>
  )
}

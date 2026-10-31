import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useSearchParams } from 'react-router-dom'
import { useApi, useAuth } from '../auth'

const API = '/api/terminal'
const THEME = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#1f6feb66',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
  cyan: '#39c5cf', white: '#b1bac4', brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
}
const STATUS_COLOR = { connecting: 'var(--yellow)', connected: 'var(--green)', closed: 'var(--text-muted)', error: 'var(--red)' }

async function call(api, url, options = {}) {
  const isJson = typeof options.body === 'string'
  const r = await api(url, isJson ? { ...options, headers: { 'Content-Type': 'application/json' } } : options)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const detail = data.detail
    const err = new Error(typeof detail === 'string' ? detail : detail?.message || `HTTP ${r.status}`)
    err.kind = detail?.kind
    throw err
  }
  return data
}

// Once a proxy has blocked the WebSocket, go straight to the HTTP fallback (per browser, best effort)
const TRANSPORT_KEY = 'baumlab.terminal.http'
const preferHttp = () => { try { return localStorage.getItem(TRANSPORT_KEY) === '1' } catch { return false } }
const rememberHttp = () => { try { localStorage.setItem(TRANSPORT_KEY, '1') } catch { /* private mode */ } }

/** One tab: an xterm.js terminal over /api/terminal/ws, or the HTTP relay when a proxy blocks WebSockets. Stays mounted while hidden to keep scrollback. */
function TerminalTab({ api, tab, active, onStatus, onHostKeyReset }) {
  const boxRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const transportRef = useRef(null)      // { send, resize, close } — WebSocket or the HTTP fallback
  const [state, setState] = useState({ status: 'connecting', message: '', hostkey: false })

  function setStatus(next) {
    setState(s => ({ ...s, ...next }))
    if (next.status) onStatus(tab.id, next.status)
  }

  async function connect() {
    const term = termRef.current
    transportRef.current?.close()
    setStatus({ status: 'connecting', message: '', hostkey: false })
    term.writeln(`\x1b[90mConnecting to ${tab.name}…\x1b[0m`)
    if (preferHttp()) { connectHttp(); return }
    let ticket
    try {
      ticket = (await call(api, `${API}/ticket`, { method: 'POST', body: JSON.stringify({ host_id: tab.hostId }) })).ticket
    } catch (e) {
      term.writeln(`\x1b[31m${e.message}\x1b[0m`)
      setStatus({ status: 'error', message: e.message })
      return
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}${API}/ws/${tab.hostId}?ticket=${encodeURIComponent(ticket)}&cols=${term.cols}&rows=${term.rows}`)
    ws.binaryType = 'arraybuffer'
    let opened = false, closing = false
    transportRef.current = {
      send: data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })) },
      resize: (cols, rows) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })) },
      close: () => { closing = true; ws.close() },
    }
    ws.onopen = () => { opened = true }
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return }
      const msg = JSON.parse(ev.data)
      if (msg.type === 'connected') {
        setStatus({ status: 'connected' })
        term.focus()
      } else if (msg.type === 'error') {
        term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`)
        setStatus({ status: 'error', message: msg.message, hostkey: msg.kind === 'hostkey' })
      } else if (msg.type === 'closed') {
        term.writeln(`\r\n\x1b[90m[session closed: ${msg.reason}]\x1b[0m`)
        setStatus({ status: 'closed', message: msg.reason })
      }
    }
    ws.onclose = () => {
      if (closing) return
      if (!opened) {
        // The upgrade never completed — a proxy in between dropped it. Plain HTTP gets through anything.
        term.writeln('\x1b[90mWebSocket blocked on the way to BaumLab — using HTTP streaming instead.\x1b[0m')
        rememberHttp()
        connectHttp()
        return
      }
      setState(s => {
        if (s.status === 'connecting' || s.status === 'connected') {
          term.writeln('\r\n\x1b[90m[connection lost]\x1b[0m')
          onStatus(tab.id, 'closed')
          return { ...s, status: 'closed', message: 'connection lost' }
        }
        return s
      })
    }
  }

  /** Fallback transport: output streamed on one HTTP response, keystrokes posted in order. */
  async function connectHttp() {
    const term = termRef.current
    let id
    try {
      id = (await call(api, `${API}/relay`, { method: 'POST',
        body: JSON.stringify({ host_id: tab.hostId, cols: term.cols, rows: term.rows }) })).id
    } catch (e) {
      term.writeln(`\r\n\x1b[31m${e.message}\x1b[0m`)
      setStatus({ status: 'error', message: e.message, hostkey: e.kind === 'hostkey' })
      return
    }
    const ctrl = new AbortController()
    let live = true, pending = '', sending = false
    const post = (path, body) => api(`${API}/relay/${id}/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
    async function flush() {                 // one request at a time keeps keystrokes in order
      if (sending || !pending) return
      sending = true
      const data = pending
      pending = ''
      await post('input', { data })
      sending = false
      flush()
    }
    transportRef.current = {
      send: data => { pending += data; flush() },
      resize: (cols, rows) => post('resize', { cols, rows }),
      close: () => { live = false; ctrl.abort(); api(`${API}/relay/${id}`, { method: 'DELETE' }).catch(() => {}) },
    }
    setStatus({ status: 'connected' })
    term.focus()
    try {
      const r = await api(`${API}/relay/${id}/stream`, { signal: ctrl.signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line) continue
          const msg = JSON.parse(line)
          if (msg.t === 'o') term.write(Uint8Array.from(atob(msg.d), c => c.charCodeAt(0)))
          else if (msg.t === 'closed') {
            live = false
            term.writeln(`\r\n\x1b[90m[session closed: ${msg.reason}]\x1b[0m`)
            setStatus({ status: 'closed', message: msg.reason })
          }
        }
      }
    } catch { /* aborted, or the network dropped — handled below */ }
    if (live) {
      live = false
      term.writeln('\r\n\x1b[90m[connection lost]\x1b[0m')
      setStatus({ status: 'closed', message: 'connection lost' })
    }
  }

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, theme: THEME,
                                fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace' })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(boxRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    const input = term.onData(data => transportRef.current?.send(data))
    const resize = term.onResize(({ cols, rows }) => transportRef.current?.resize(cols, rows))
    const observer = new ResizeObserver(() => { if (boxRef.current?.offsetParent) fit.fit() })
    observer.observe(boxRef.current)
    connect()
    return () => {
      observer.disconnect(); input.dispose(); resize.dispose()
      transportRef.current?.close()
      term.dispose()
    }
  }, [])

  useEffect(() => {
    if (active && fitRef.current) {
      requestAnimationFrame(() => { fitRef.current.fit(); termRef.current.focus() })
    }
  }, [active])

  async function resetAndReconnect() {
    await onHostKeyReset(tab.hostId)
    connect()
  }

  return (
    <div style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {(state.status === 'closed' || state.status === 'error') && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', fontSize: 12,
          background: state.hostkey ? '#2e1a1a' : 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: state.status === 'error' ? 'var(--red)' : 'var(--text-muted)', flex: 1 }}>
            {state.hostkey ? '⚠ Host key changed — not connected.' : state.message}
          </span>
          {state.hostkey && (
            <button className="secondary" style={{ fontSize: 12, color: 'var(--red)' }} onClick={resetAndReconnect}>
              I expected this — trust the new key and reconnect
            </button>
          )}
          {!state.hostkey && <button className="secondary" style={{ fontSize: 12 }} onClick={connect}>⟳ Reconnect</button>}
        </div>
      )}
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, padding: 6, background: THEME.background }} />
    </div>
  )
}

const blankHost = { name: '', address: '', port: 22, username: '', auth_type: 'password', secret: '', passphrase: '',
                    credential_id: null, device_id: null, service_id: null }

function HostForm({ api, initial, onSaved, onClose }) {
  const [form, setForm] = useState({ ...blankHost, ...initial, secret: '', passphrase: '' })
  const [devices, setDevices] = useState([])
  const [services, setServices] = useState([])
  const [useExisting, setUseExisting] = useState(false)
  const [vaultEntries, setVaultEntries] = useState([])
  const [error, setError] = useState('')
  const set = patch => setForm(f => ({ ...f, ...patch }))
  const editing = initial?.id != null

  useEffect(() => {
    api('/api/devices/').then(r => r.ok ? r.json() : []).then(setDevices).catch(() => {})
    api('/api/services/').then(r => r.ok ? r.json() : []).then(setServices).catch(() => {})
    api('/api/vault/').then(r => r.ok ? r.json() : []).then(setVaultEntries).catch(() => {})
  }, [])

  function pickDevice(id) {
    const d = devices.find(x => x.id === +id)
    set({ device_id: d ? d.id : null, ...(d && !form.address ? { address: d.ip } : {}),
          ...(d && !form.name ? { name: d.label || d.hostname || d.ip } : {}) })
  }

  async function save(e) {
    e.preventDefault()
    const body = { ...form, port: +form.port || 22, secret: form.secret || null,
                   passphrase: form.passphrase === '' ? null : form.passphrase,
                   credential_id: useExisting ? (form.credential_id ? +form.credential_id : null) : null }
    try {
      const saved = await call(api, editing ? `${API}/hosts/${initial.id}` : `${API}/hosts`,
                               { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) })
      onSaved(saved)
    } catch (err) { setError(err.message) }
  }

  async function clearKey() {
    if (!confirm('Forget the trusted host key? The next connection will trust whatever key the host presents.')) return
    await call(api, `${API}/hosts/${initial.id}/trust-reset`, { method: 'POST' }).catch(e => setError(e.message))
    onSaved({ ...initial, fingerprint: null })
  }

  const field = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}>
      <form className="card" onClick={e => e.stopPropagation()} onSubmit={save} style={{ width: 560, maxWidth: '100%' }}>
        <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>{editing ? `Edit ${initial.name}` : 'Add SSH host'}</h2>
        {!editing && devices.length > 0 && (
          <label style={field}>From a discovered device (optional)
            <select value={form.device_id ?? ''} onChange={e => pickDevice(e.target.value)}>
              <option value="">—</option>
              {devices.map(d => <option key={d.id} value={d.id}>{d.label || d.hostname || d.ip} ({d.ip})</option>)}
            </select>
          </label>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ ...field, flex: 1 }}>Name<input required value={form.name} onChange={e => set({ name: e.target.value })} /></label>
          <label style={{ ...field, flex: 1 }}>Linked service
            <select value={form.service_id ?? ''} onChange={e => set({ service_id: e.target.value ? +e.target.value : null })}>
              <option value="">—</option>
              {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ ...field, flex: 2 }}>Address<input required value={form.address} placeholder="192.168.1.10 or host.lan"
            style={{ fontFamily: 'monospace' }} onChange={e => set({ address: e.target.value })} /></label>
          <label style={{ ...field, width: 80 }}>Port<input type="number" value={form.port} onChange={e => set({ port: e.target.value })} /></label>
          <label style={{ ...field, flex: 1 }}>Username<input required value={form.username} onChange={e => set({ username: e.target.value })} /></label>
        </div>

        <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 10 }}>
          {['password', 'key'].map(t => (
            <label key={t} style={{ display: 'flex', gap: 6 }}>
              <input type="radio" checked={form.auth_type === t} onChange={() => set({ auth_type: t })} />
              {t === 'password' ? 'Password' : 'Private key'}
            </label>
          ))}
          <label style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <input type="checkbox" checked={useExisting} onChange={e => setUseExisting(e.target.checked)} /> Use an existing vault entry
          </label>
        </div>
        {useExisting ? (
          <label style={field}>Vault entry
            <select required value={form.credential_id ?? ''} onChange={e => set({ credential_id: e.target.value })}>
              <option value="">— choose —</option>
              {vaultEntries.map(v => <option key={v.id} value={v.id}>{v.title}{v.username ? ` (${v.username})` : ''}</option>)}
            </select>
          </label>
        ) : form.auth_type === 'password' ? (
          <label style={field}>Password {editing && initial.has_secret && '— saved in the vault; blank keeps it'}
            <input type="password" autoComplete="new-password" required={!editing || !initial.has_secret}
              value={form.secret} onChange={e => set({ secret: e.target.value })} />
          </label>
        ) : <>
          <label style={field}>Private key (OpenSSH / PEM) {editing && initial.has_secret && '— saved in the vault; blank keeps it'}
            <textarea rows={5} required={!editing || !initial.has_secret} value={form.secret} spellCheck={false}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              style={{ fontFamily: 'monospace', fontSize: 11, background: 'var(--bg2)', color: 'var(--text)',
                       border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
              onChange={e => set({ secret: e.target.value })} />
          </label>
          <label style={field}>Key passphrase {editing && initial.has_passphrase ? '— saved; blank keeps it' : '(if any)'}
            <input type="password" autoComplete="new-password" value={form.passphrase} onChange={e => set({ passphrase: e.target.value })} />
          </label>
        </>}

        {editing && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Trusted host key: {initial.fingerprint ? <code>{initial.fingerprint}</code> : 'none yet — trusted on next connect'}
            {initial.fingerprint && <button type="button" className="secondary" style={{ fontSize: 11, marginLeft: 8, padding: '1px 8px' }}
              onClick={clearKey}>Forget</button>}
          </div>
        )}
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          Passwords and keys are stored in the vault ("SSH: {form.name || 'name'}") and decrypted only while connecting.
        </p>
        {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit">{editing ? 'Save' : 'Add host'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  )
}

export default function TerminalPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [hosts, setHosts] = useState(null)
  const [locked, setLocked] = useState('')
  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [editing, setEditing] = useState(null)
  const [filter, setFilter] = useState('')
  const [testResult, setTestResult] = useState({})
  const [showLog, setShowLog] = useState(false)
  const [sessions, setSessions] = useState([])
  const [params, setParams] = useSearchParams()

  async function load() {
    const r = await api(`${API}/hosts`)
    const data = await r.json().catch(() => ({}))
    if (r.ok) { setHosts(data); setLocked('') }
    else { setHosts([]); setLocked(data.detail || `HTTP ${r.status}`) }
  }
  useEffect(() => { if (isAdmin) load() }, [isAdmin])

  // Links from the Services page: ?host=<id> opens a tab, ?service=<id> starts "Add host" pre-filled
  useEffect(() => {
    if (!hosts) return
    const hostId = Number(params.get('host'))
    const serviceId = Number(params.get('service'))
    if (hostId) {
      const h = hosts.find(x => x.id === hostId)
      if (h) open(h)
      setParams({})
    } else if (serviceId) {
      api('/api/services/').then(r => r.ok ? r.json() : []).then(list => {
        const s = list.find(x => x.id === serviceId)
        if (s) setEditing({ name: s.name, address: s.ip || '', port: s.port || 22, service_id: s.id })
      }).catch(() => {})
      setParams({})
    }
  }, [hosts])
  useEffect(() => {
    if (showLog) call(api, `${API}/sessions?limit=50`).then(setSessions).catch(() => {})
  }, [showLog, tabs.length])

  function open(host) {
    const id = Math.random().toString(36).slice(2)
    setTabs(t => [...t, { id, hostId: host.id, name: host.name, status: 'connecting' }])
    setActiveId(id)
  }

  function close(id) {
    setTabs(t => {
      const next = t.filter(x => x.id !== id)
      if (activeId === id) setActiveId(next.length ? next[next.length - 1].id : null)
      return next
    })
  }

  const setTabStatus = (id, status) => setTabs(t => t.map(x => x.id === id ? { ...x, status } : x))

  async function test(h) {
    setTestResult(r => ({ ...r, [h.id]: { pending: true } }))
    try {
      const res = await call(api, `${API}/hosts/${h.id}/test`, { method: 'POST' })
      setTestResult(r => ({ ...r, [h.id]: { ok: true, text: res.output } }))
      load()
    } catch (e) { setTestResult(r => ({ ...r, [h.id]: { ok: false, text: e.message } })) }
  }

  async function remove(h) {
    if (!confirm(`Remove ${h.name}? Its login stays in the vault.`)) return
    await call(api, `${API}/hosts/${h.id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  async function resetHostKey(hostId) {
    await call(api, `${API}/hosts/${hostId}/trust-reset`, { method: 'POST' })
  }

  if (!isAdmin) return <div><h1>Terminal</h1><p style={{ color: 'var(--text-muted)' }}>Admin access required.</p></div>
  if (!hosts) return <div><h1>Terminal</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const shown = hosts.filter(h => !filter || `${h.name} ${h.address} ${h.username}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 48px)' }}>
      {/* ── Hosts ── */}
      <aside style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ margin: 0 }}>Terminal</h1>
          <button style={{ marginLeft: 'auto' }} onClick={() => setEditing({})} disabled={!!locked}>+ Host</button>
        </div>
        {locked && <div className="card" style={{ borderColor: 'var(--red)', fontSize: 12 }}>🔒 {locked}</div>}
        {hosts.length > 4 && <input placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} />}
        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!locked && hosts.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No hosts yet. Add one — you can pick it from your discovered devices.</div>
          )}
          {shown.map(h => (
            <div key={h.id} className="card" style={{ marginBottom: 0, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{h.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {h.username}@{h.address}{h.port !== 22 ? `:${h.port}` : ''}
                  </div>
                </div>
                <button onClick={() => open(h)} title="Open a terminal tab" style={{ padding: '4px 10px' }}>›_</button>
              </div>
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                <button className="secondary" style={{ fontSize: 11, padding: '1px 8px' }} onClick={() => test(h)}>Test</button>
                <button className="secondary" style={{ fontSize: 11, padding: '1px 8px' }} onClick={() => setEditing(h)}>Edit</button>
                <button className="secondary" style={{ fontSize: 11, padding: '1px 8px', color: 'var(--red)' }} onClick={() => remove(h)}>✕</button>
                {!h.has_secret && <span className="badge badge-yellow" style={{ marginLeft: 'auto' }}>no login</span>}
              </div>
              {testResult[h.id] && (
                <div style={{ fontSize: 11, marginTop: 6, fontFamily: 'monospace', whiteSpace: 'pre-wrap',
                  color: testResult[h.id].pending ? 'var(--text-muted)' : testResult[h.id].ok ? 'var(--green)' : 'var(--red)' }}>
                  {testResult[h.id].pending ? 'Testing…' : testResult[h.id].text}
                </div>
              )}
            </div>
          ))}
        </div>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6 }}>
          <input type="checkbox" checked={showLog} onChange={e => setShowLog(e.target.checked)} /> Session log
        </label>
      </aside>

      {/* ── Tabs ── */}
      <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)',
        borderRadius: 8, overflow: 'hidden', background: THEME.background }}>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg2)', borderBottom: '1px solid var(--border)', overflowX: 'auto', minHeight: 36 }}>
          {tabs.map(t => (
            <div key={t.id} onClick={() => setActiveId(t.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
                       background: t.id === activeId ? THEME.background : 'transparent',
                       borderRight: '1px solid var(--border)', color: t.id === activeId ? 'var(--text)' : 'var(--text-muted)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[t.status] }} />
              {t.name}
              <span onClick={e => { e.stopPropagation(); close(t.id) }} style={{ color: 'var(--text-muted)', marginLeft: 4 }} title="Close">✕</span>
            </div>
          ))}
        </div>
        {tabs.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Pick a host and press ›_ to open a terminal. Open as many tabs as you like.
          </div>
        )}
        {tabs.map(t => (
          <TerminalTab key={t.id} api={api} tab={t} active={t.id === activeId} onStatus={setTabStatus} onHostKeyReset={resetHostKey} />
        ))}
        {showLog && (
          <div style={{ maxHeight: 200, overflowY: 'auto', borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
            <table style={{ fontSize: 12 }}>
              <thead><tr><th>Started</th><th>Host</th><th>User</th><th>From</th><th>Ended</th><th>Reason</th></tr></thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td>{new Date(s.started_at + 'Z').toLocaleString()}</td>
                    <td>{s.host_name}</td><td>{s.actor}</td><td>{s.client_ip || '—'}</td>
                    <td>{s.ended_at ? new Date(s.ended_at + 'Z').toLocaleTimeString() : <span style={{ color: 'var(--green)' }}>open</span>}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{s.end_reason || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && <HostForm api={api} initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load() }} />}
    </div>
  )
}

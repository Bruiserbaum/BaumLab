import React, { useEffect, useState, useCallback } from 'react'
import { useApi } from '../auth'

const API = '/api/unifi'
const REFRESH_MS = 60_000

function fmt_bytes(b) {
  if (b == null) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`
  return `${(b / 1073741824).toFixed(2)} GB`
}

function fmt_uptime(secs) {
  if (secs == null) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function signal_color(s) {
  if (s == null) return 'var(--text-muted)'
  if (s >= -60) return '#3fb950'   // good
  if (s >= -75) return '#e3b341'   // ok
  return '#f85149'                  // weak
}

function SignalBar({ signal }) {
  if (signal == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  const color = signal_color(signal)
  return (
    <span style={{ color, fontFamily: 'monospace', fontSize: 12 }}>
      {signal} dBm
    </span>
  )
}

export default function UniFiPage() {
  const api = useApi()
  const [tab, setTab]         = useState('clients')
  const [clients, setClients] = useState([])
  const [devices, setDevices] = useState([])
  const [networks, setNetworks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')
  const [filterVlan, setFilterVlan] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const [cr, dr, nr] = await Promise.all([
        api(`${API}/clients`),
        api(`${API}/devices`),
        api(`${API}/networks`),
      ])
      if (!cr.ok) throw new Error((await cr.json()).detail || `HTTP ${cr.status}`)
      setClients(await cr.json())
      if (dr.ok) setDevices(await dr.json())
      if (nr.ok) setNetworks(await nr.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [])

  // Build VLAN name map from networks
  const vlanNames = {}
  for (const n of networks) {
    if (n.vlan_enabled && n.vlan != null) vlanNames[n.vlan] = n.name
    else if (n.name) vlanNames[n.networkgroup ?? n.name] = n.name
  }

  const vlans = [...new Set(clients.map(c => c.vlan ?? c.network ?? '').filter(Boolean))].sort()

  const filtered = clients.filter(c => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      (c.hostname || '').toLowerCase().includes(q) ||
      (c.name || '').toLowerCase().includes(q) ||
      (c.mac || '').toLowerCase().includes(q) ||
      (c.ip || '').toLowerCase().includes(q) ||
      (c.network || '').toLowerCase().includes(q) ||
      (c.oui || '').toLowerCase().includes(q)
    const matchVlan = !filterVlan ||
      String(c.vlan ?? '') === filterVlan ||
      (c.network ?? '') === filterVlan
    return matchSearch && matchVlan
  })

  const wired    = filtered.filter(c => c.is_wired)
  const wireless = filtered.filter(c => !c.is_wired)

  if (loading) return <div><h1>UniFi</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  return (
    <div>
      <h1>UniFi</h1>

      {error && (
        <div style={{
          color: 'var(--red)', background: '#2e1a1a', border: '1px solid var(--red)',
          borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13,
        }}>
          ✗ {error}
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {['clients', 'infrastructure'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={tab === t ? '' : 'secondary'}
            style={{ textTransform: 'capitalize' }}>
            {t === 'clients' ? `Clients (${clients.length})` : `Infrastructure (${devices.length})`}
          </button>
        ))}
        <button className="secondary" style={{ marginLeft: 'auto' }} onClick={load}>Refresh</button>
      </div>

      {/* ── Clients tab ── */}
      {tab === 'clients' && (
        <>
          {/* Filters */}
          <div className="toolbar" style={{ marginBottom: 16 }}>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search hostname, MAC, IP, vendor…"
              style={{ width: 260 }}
            />
            {vlans.length > 0 && (
              <select value={filterVlan} onChange={e => setFilterVlan(e.target.value)}>
                <option value="">All VLANs / Networks</option>
                {vlans.map(v => (
                  <option key={v} value={String(v)}>
                    {vlanNames[v] ? `${vlanNames[v]} (${v})` : v}
                  </option>
                ))}
              </select>
            )}
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 13 }}>
              {wired.length} wired · {wireless.length} wireless
            </span>
          </div>

          <ClientTable rows={wired}    label="Wired"    vlanNames={vlanNames} />
          <ClientTable rows={wireless} label="Wireless" vlanNames={vlanNames} />
        </>
      )}

      {/* ── Infrastructure tab ── */}
      {tab === 'infrastructure' && (
        <InfraTable devices={devices} />
      )}
    </div>
  )
}

function ClientTable({ rows, label, vlanNames }) {
  if (rows.length === 0) return null
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px',
        color: 'var(--text-muted)', marginBottom: 8,
      }}>
        {label} — {rows.length}
      </div>
      <table>
        <thead>
          <tr>
            <th>Name / Hostname</th>
            <th>IP</th>
            <th>MAC</th>
            <th>Vendor</th>
            <th>Network / VLAN</th>
            {label === 'Wireless' && <th>SSID</th>}
            {label === 'Wireless' && <th>Signal</th>}
            {label === 'Wired'    && <th>Switch Port</th>}
            <th>Uptime</th>
            <th>RX</th>
            <th>TX</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => {
            const displayName = c.name || c.hostname || '—'
            const vlanLabel   = c.vlan != null
              ? (vlanNames[c.vlan] ? `${vlanNames[c.vlan]} (${c.vlan})` : `VLAN ${c.vlan}`)
              : (c.network || '—')
            return (
              <tr key={c.mac}>
                <td>
                  <div style={{ fontWeight: c.name ? 600 : 400 }}>{c.name || '—'}</div>
                  {c.hostname && c.hostname !== c.name && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      {c.hostname}
                    </div>
                  )}
                </td>
                <td style={{ fontFamily: 'monospace' }}>{c.ip || '—'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.mac}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.oui || '—'}</td>
                <td>
                  <span style={{
                    fontSize: 11, background: 'var(--border)', color: 'var(--text-muted)',
                    padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace',
                  }}>
                    {vlanLabel}
                  </span>
                </td>
                {label === 'Wireless' && (
                  <td style={{ fontSize: 12 }}>{c.essid || '—'}</td>
                )}
                {label === 'Wireless' && (
                  <td><SignalBar signal={c.signal ?? c.rssi} /></td>
                )}
                {label === 'Wired' && (
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {c.sw_port != null ? `Port ${c.sw_port}` : '—'}
                  </td>
                )}
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt_uptime(c.uptime)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{fmt_bytes(c.rx_bytes)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{fmt_bytes(c.tx_bytes)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function InfraTable({ devices }) {
  if (devices.length === 0) return (
    <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>No infrastructure devices found.</div>
  )
  return (
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Name</th>
          <th>Model</th>
          <th>IP</th>
          <th>MAC</th>
          <th>Version</th>
          <th>Uptime</th>
          <th>Clients</th>
        </tr>
      </thead>
      <tbody>
        {devices.map(d => {
          const adopted = d.state === 1
          const dot     = adopted ? '#3fb950' : '#e3b341'
          return (
            <tr key={d.mac}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{
                    width: 9, height: 9, borderRadius: '50%', background: dot,
                    boxShadow: adopted ? `0 0 5px ${dot}` : 'none',
                  }} />
                  <span style={{ fontSize: 12, color: dot }}>
                    {adopted ? 'Connected' : 'Isolated'}
                  </span>
                </div>
              </td>
              <td style={{ fontWeight: 600 }}>{d.name || d.hostname || '—'}</td>
              <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{d.model || '—'}</td>
              <td style={{ fontFamily: 'monospace' }}>{d.ip || '—'}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{d.mac}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{d.version || '—'}</td>
              <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt_uptime(d.uptime)}</td>
              <td style={{ fontSize: 12 }}>{d.num_sta ?? '—'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../auth'

const API = import.meta.env.VITE_API_URL ?? ''

const SEV_NAMES = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Info', 'Debug']
const SEV_COLORS = {
  Emergency: '#ff4444', Alert: '#ff4444', Critical: '#ff4444',
  Error: '#e87a30', Warning: '#d4b800', Notice: '#4f9fe8',
  Info: undefined, Debug: '#888',
}

const REFRESH_MS = 10_000

export default function SyslogPage() {
  const { api } = useAuth()
  const [messages, setMessages] = useState([])
  const [stats, setStats] = useState(null)
  const [severityMax, setSeverityMax] = useState(7)
  const [host, setHost] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)
  const intervalRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ severity_max: severityMax, limit: 500 })
      if (host) params.set('host', host)
      if (search) params.set('search', search)
      const [msgR, statR] = await Promise.all([
        api(`${API}/api/syslog?${params}`),
        api(`${API}/api/syslog/stats`),
      ])
      if (msgR.ok) setMessages(await msgR.json())
      if (statR.ok) setStats(await statR.json())
    } finally {
      setLoading(false)
    }
  }, [api, severityMax, host, search])

  useEffect(() => {
    load()
    intervalRef.current = setInterval(load, REFRESH_MS)
    return () => clearInterval(intervalRef.current)
  }, [load])

  async function clearAll() {
    if (!confirm('Delete all syslog messages?')) return
    await api(`${API}/api/syslog`, { method: 'DELETE' })
    setMessages([])
    setStats(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '8px 0' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Total: <b style={{ color: 'var(--text)' }}>{stats.total.toLocaleString()}</b>
          </span>
          {Object.entries(stats.by_severity).map(([sev, n]) => (
            <span key={sev} style={{ fontSize: 13 }}>
              <span style={{ color: SEV_COLORS[sev] ?? 'var(--text-muted)' }}>{sev}:</span>{' '}
              <b style={{ color: 'var(--text)' }}>{n}</b>
            </span>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={severityMax}
          onChange={e => setSeverityMax(Number(e.target.value))}
          style={{ width: 140 }}
        >
          <option value={2}>Critical+</option>
          <option value={3}>Error+</option>
          <option value={4}>Warning+</option>
          <option value={6}>Info+</option>
          <option value={7}>All Levels</option>
        </select>
        <input
          placeholder="Filter host…"
          value={host}
          onChange={e => setHost(e.target.value)}
          style={{ width: 140 }}
        />
        <input
          placeholder="Search message / tag…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 200 }}
        />
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button className="secondary" onClick={clearAll}>Clear All</button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
          Auto-refresh every 10 s
        </span>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <th style={th}>Time</th>
              <th style={th}>Severity</th>
              <th style={th}>Host</th>
              <th style={th}>Facility</th>
              <th style={th}>Tag</th>
              <th style={{ ...th, width: '40%' }}>Message</th>
            </tr>
          </thead>
          <tbody>
            {messages.map(m => (
              <tr
                key={m.id}
                onClick={() => setSelected(selected?.id === m.id ? null : m)}
                style={{
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: selected?.id === m.id ? 'var(--surface-hover)' : undefined,
                }}
              >
                <td style={td}>{new Date(m.received_at).toLocaleTimeString()}</td>
                <td style={{ ...td, color: SEV_COLORS[m.severity_name] ?? 'var(--text-muted)', fontWeight: 500 }}>
                  {m.severity_name}
                </td>
                <td style={td}>{m.host}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{m.facility_name}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{m.tag}</td>
                <td style={{ ...td, fontFamily: 'monospace', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.message}
                </td>
              </tr>
            ))}
            {messages.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                  No syslog messages. Configure your devices to send syslog to this host on UDP port 514.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Detail panel */}
      {selected && (
        <div style={{
          borderTop: '1px solid var(--border)', padding: 12, background: 'var(--surface)',
          fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          maxHeight: 140, overflow: 'auto',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Raw: </span>{selected.raw}
        </div>
      )}
    </div>
  )
}

const th = { padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }
const td = { padding: '5px 10px', color: 'var(--text)' }

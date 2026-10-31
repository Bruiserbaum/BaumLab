import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../auth'

const API = import.meta.env.VITE_API_URL ?? ''

const SEV_NAMES = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Info', 'Debug']
const SEV_COLORS = {
  Emergency: '#ff4444', Alert: '#ff4444', Critical: '#ff4444',
  Error: '#e87a30', Warning: '#d4b800', Notice: '#4f9fe8',
  Info: undefined, Debug: '#888',
}

const REFRESH_MS = 10_000
const DOWNLOAD_RANGES = [[10, 'Last 10 minutes'], [60, 'Last hour'], [1440, 'Last day'], [10080, 'Last 7 days']]
const SOURCE_LABELS = { network: 'Network', container: 'Containers', audit: 'Activity' }

export default function SyslogPage() {
  const api = useApi()
  const [messages, setMessages] = useState([])
  const [stats, setStats] = useState(null)
  const [severityMax, setSeverityMax] = useState(7)
  const [host, setHost] = useState('')
  const [search, setSearch] = useState('')
  const [params] = useSearchParams()
  const [source, setSource] = useState(params.get('source') || '')   // '' | network | container | audit
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const intervalRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ severity_max: severityMax, limit: 500 })
      if (host) params.set('host', host)
      if (search) params.set('search', search)
      if (source) params.set('source', source)
      const [msgR, statR] = await Promise.all([
        api(`${API}/api/syslog/?${params}`),
        api(`${API}/api/syslog/stats`),
      ])
      if (msgR.ok) setMessages(await msgR.json())
      if (statR.ok) setStats(await statR.json())
    } finally {
      setLoading(false)
    }
  }, [api, severityMax, host, search, source])

  useEffect(() => {
    load()
    intervalRef.current = setInterval(load, REFRESH_MS)
    return () => clearInterval(intervalRef.current)
  }, [load])

  async function download(minutes) {
    if (!minutes) return
    setDownloading(true)
    try {
      const p = new URLSearchParams({ minutes, severity_max: severityMax })
      if (host) p.set('host', host)
      if (search) p.set('search', search)
      if (source) p.set('source', source)
      const r = await api(`${API}/api/syslog/download?${p}`)
      if (!r.ok) { alert(`Download failed (HTTP ${r.status})`); return }
      const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'baumlab-syslog.log'
      const url = URL.createObjectURL(await r.blob())
      const a = Object.assign(document.createElement('a'), { href: url, download: name })
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  async function clearAll() {
    if (!confirm('Delete all syslog messages?')) return
    await api(`${API}/api/syslog/`, { method: 'DELETE' })
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
          {stats.by_source && Object.entries(stats.by_source).map(([src, n]) => (
            <span key={src} style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {SOURCE_LABELS[src] || src}: <b style={{ color: 'var(--text)' }}>{n.toLocaleString()}</b>
            </span>
          ))}
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
        <select value={source} onChange={e => setSource(e.target.value)} style={{ width: 170 }} title="Where the messages came from">
          <option value="">All sources</option>
          <option value="network">Network devices (UDP)</option>
          <option value="container">BaumLab containers</option>
          <option value="audit">BaumLab activity</option>
        </select>
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
        <select value="" onChange={e => download(+e.target.value)} disabled={downloading}
          style={{ width: 150 }} title="Save a log file with the current filters — for troubleshooting or sharing">
          <option value="" disabled>{downloading ? 'Preparing…' : '⬇ Download log'}</option>
          {DOWNLOAD_RANGES.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
        </select>
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
                  No messages yet. Network devices can send syslog to this host on UDP port 514; BaumLab's own container logs and activity appear here automatically.
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

import React, { useEffect, useRef, useState } from 'react'

export const API = '/api/backups'

export const CRON_PRESETS = [
  ['0 3 * * *', 'Daily at 03:00'],
  ['0 1 * * *', 'Daily at 01:00'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 3 * * 0', 'Weekly (Sunday 03:00)'],
  ['0 3 1 * *', 'Monthly (1st, 03:00)'],
]

const BADGES = {
  ok:       ['green', 'OK'],
  success:  ['green', 'Success'],
  stale:    ['yellow', 'Stale'],
  warning:  ['yellow', 'Warning'],
  failed:   ['red', 'Failed'],
  never:    ['gray', 'Never run'],
  disabled: ['gray', 'Disabled'],
  none:     ['red', 'No backup'],
  running:  ['blue', 'Running'],
}

export function StatusBadge({ status, title }) {
  const [color, label] = BADGES[status] ?? ['gray', status ?? '—']
  return <span className={`badge badge-${color}`} title={title}>{label}</span>
}

// Backend datetimes are naive UTC
const toDate = v => v ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : v + 'Z') : null

export function ago(v) {
  const d = toDate(v)
  if (!d) return '—'
  const secs = Math.round((Date.now() - d.getTime()) / 1000)
  const future = secs < 0
  const s = Math.abs(secs)
  const text = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
  return future ? `in ${text}` : `${text} ago`
}

export const fullDate = v => toDate(v)?.toLocaleString() ?? '—'

export function fmtBytes(n) {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

export function Field({ label, hint, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, ...style }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}{hint && <span style={{ fontWeight: 400, marginLeft: 6 }}>— {hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function Notice({ notice, onClose }) {
  if (!notice) return null
  return (
    <div style={{ fontSize: 12, marginBottom: 12, padding: '8px 12px', borderRadius: 6, display: 'flex',
      justifyContent: 'space-between', gap: 12, color: notice.ok ? 'var(--green)' : 'var(--red)',
      border: `1px solid ${notice.ok ? 'var(--green)' : 'var(--red)'}`, background: notice.ok ? '#1a2e1a' : '#2e1a1a' }}>
      <span>{notice.ok ? '✓' : '✗'} {notice.text}</span>
      <span style={{ cursor: 'pointer' }} onClick={onClose}>✕</span>
    </div>
  )
}

export function Modal({ title, onClose, children, width = 720 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width, maxWidth: '100%', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>{title}</h2>
          <button className="secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Live log for one run; polls while it is running. */
export function RunLog({ api, runId, onClose }) {
  const [run, setRun] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    let timer
    async function load() {
      const r = await api(`${API}/runs/${runId}`)
      if (!r.ok) return
      const data = await r.json()
      setRun(data)
      if (data.status === 'running') timer = setTimeout(load, 2000)
    }
    load()
    return () => clearTimeout(timer)
  }, [runId])

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [run])

  return (
    <Modal title={run ? `${run.run_type === 'restore' ? 'Restore' : 'Backup'}: ${run.name}` : 'Run'} onClose={onClose}>
      {run && (
        <>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, flexWrap: 'wrap' }}>
            <StatusBadge status={run.status} />
            <span>Started {fullDate(run.started_at)}</span>
            {run.size_bytes != null && <span>{fmtBytes(run.size_bytes)}</span>}
            {run.archive_path && <code>{run.archive_path}</code>}
          </div>
          <div ref={ref} style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 6, padding: 10, maxHeight: '55vh', overflowY: 'auto', lineHeight: 1.6 }}>
            {run.log_lines.map((l, i) => (
              <div key={i} style={{ color: l.includes('WARNING') ? 'var(--yellow)' : l.includes('failed') ? 'var(--red)' : 'var(--text)' }}>{l}</div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

export async function apiJson(api, url, options = {}) {
  // Only JSON strings get a JSON content type — FormData uploads set their own multipart header
  const isJson = typeof options.body === 'string'
  const r = await api(url, isJson ? { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } } : options)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : `HTTP ${r.status}`)
  return data
}

/** Checkbox list for picking linked services. */
export function ServicePicker({ services, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', maxHeight: 120, overflowY: 'auto',
      border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
      {services.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No services yet</span>}
      {services.map(s => (
        <label key={s.id} style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={value.includes(s.id)}
            onChange={e => onChange(e.target.checked ? [...value, s.id] : value.filter(id => id !== s.id))} />
          {s.name}
        </label>
      ))}
    </div>
  )
}

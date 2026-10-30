import React, { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth'

export const STATE_COLORS = {
  running: 'var(--green)', paused: '#d4b800', created: '#4f9fe8',
  restarting: '#e87a30', exited: '#e87a30', dead: '#ff4444',
}

/** Key that ties a service to a Portainer container snapshot. */
export const containerKey = (connection, endpointId, name) => `${connection}|${endpointId}|${name}`

export function ContainerBadge({ container, onClick }) {
  if (!container) return <span className="badge badge-gray" title="Linked container not found in the last Portainer poll">gone</span>
  return (
    <span className="badge" onClick={onClick} title={`${container.name} — ${container.status_text}`}
      style={{ cursor: onClick ? 'pointer' : 'default', color: STATE_COLORS[container.state] ?? 'var(--text-muted)',
               border: `1px solid ${STATE_COLORS[container.state] ?? 'var(--border)'}`, background: 'transparent' }}>
      🐳 {container.state}
    </span>
  )
}

/** Modal: container details, start / stop / restart (admins), recent logs. */
export default function ContainerPanel({ api, container, onClose, onChanged }) {
  const { isAdmin } = useAuth()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [logs, setLogs] = useState(null)
  const logRef = useRef(null)
  const ref = { connection: container.connection_name, endpoint_id: container.endpoint_id, container: container.container_id }

  async function loadLogs() {
    setError('')
    const q = new URLSearchParams({ ...ref, tail: '300' })
    const r = await api(`/api/portainer/containers/logs?${q}`)
    const data = await r.json().catch(() => ({}))
    if (r.ok) setLogs(data.logs || '(no output)')
    else setError(data.detail || `HTTP ${r.status}`)
  }

  useEffect(() => { if (isAdmin) loadLogs() }, [])
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [logs])

  async function act(action) {
    if (action !== 'start' && !confirm(`${action[0].toUpperCase() + action.slice(1)} ${container.name}?`)) return
    setBusy(action); setError('')
    const r = await api('/api/portainer/containers/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ref, action }),
    })
    const data = await r.json().catch(() => ({}))
    setBusy('')
    if (!r.ok) { setError(data.detail || `HTTP ${r.status}`); return }
    onChanged?.()
    loadLogs()
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 55,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 860, maxWidth: '100%', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>🐳 {container.name}</h2>
          <ContainerBadge container={container} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{container.status_text}</span>
          <button type="button" className="secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          <code>{container.image}</code> · {container.endpoint_name} ({container.connection_name}) · id {container.container_id}
        </div>
        {isAdmin ? (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button type="button" disabled={!!busy || container.state === 'running'} onClick={() => act('start')}>
                {busy === 'start' ? 'Starting…' : '▶ Start'}</button>
              <button type="button" className="secondary" disabled={!!busy || container.state !== 'running'} onClick={() => act('restart')}>
                {busy === 'restart' ? 'Restarting…' : '⟳ Restart'}</button>
              <button type="button" className="secondary" style={{ color: 'var(--red)' }} disabled={!!busy || container.state !== 'running'}
                onClick={() => act('stop')}>{busy === 'stop' ? 'Stopping…' : '■ Stop'}</button>
              <button type="button" className="secondary" style={{ marginLeft: 'auto' }} onClick={loadLogs}>Refresh logs</button>
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
            <pre ref={logRef} style={{ margin: 0, maxHeight: '50vh', overflow: 'auto', fontSize: 11, lineHeight: 1.5,
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap' }}>
              {logs ?? 'Loading logs…'}
            </pre>
          </>
        ) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Admins can start, stop and restart containers and read logs.</div>}
      </div>
    </div>
  )
}

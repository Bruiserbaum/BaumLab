import React, { useCallback, useEffect, useState } from 'react'
import { useApi } from '../auth'

// state from /api/vuln-scan/health → badge label and colour
export const OPENVAS_STATES = {
  ready:        ['Ready', 'badge-green'],
  updating:     ['Ready · updating feeds', 'badge-green'],
  loading:      ['Loading feeds', 'badge-yellow'],
  starting:     ['Starting', 'badge-yellow'],
  stopped:      ['Stopped', 'badge-red'],
  missing:      ['Not deployed', 'badge-red'],
  auth_failed:  ['Login failed', 'badge-red'],
  unreachable:  ['Unreachable', 'badge-red'],
  unconfigured: ['Not configured', 'badge-gray'],
  error:        ['Error', 'badge-red'],
  unknown:      ['Checking…', 'badge-gray'],
}

const POLL_BUSY_MS = 10_000    // while starting / loading feeds
const POLL_IDLE_MS = 60_000

/** Live status of the bundled OpenVAS container — BaumLab provisions it, this shows how far it has got. */
export default function OpenVasStatus() {
  const api = useApi()
  const [st, setSt] = useState(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async (refresh = false) => {
    if (refresh) setChecking(true)
    try {
      const r = await api(`/api/vuln-scan/health${refresh ? '?refresh=1' : ''}`)
      if (r.ok) setSt(await r.json())
    } finally {
      setChecking(false)
    }
  }, [api])

  useEffect(() => { load() }, [load])

  const settled = st && ['ready', 'updating'].includes(st.state)
  useEffect(() => {
    const t = setInterval(() => load(), settled ? POLL_IDLE_MS : POLL_BUSY_MS)
    return () => clearInterval(t)
  }, [load, settled])

  const [label, badge] = OPENVAS_STATES[st?.state] || OPENVAS_STATES.unknown
  const checkedAgo = st?.checked ? Math.max(0, Math.round(Date.now() / 1000 - st.checked)) : null

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className={`badge ${badge}`}>{label}</span>
        {st?.version && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>GVM {st.version}</span>}
        {st?.container && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {st.container}</span>}
        <button type="button" className="secondary" style={{ marginLeft: 'auto', fontSize: 12 }}
          onClick={() => load(true)} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {st?.message && <div style={{ fontSize: 13, marginTop: 8 }}>{st.message}</div>}
      {st?.activity && !settled && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace' }}>
          gvmd: {st.activity}
        </div>
      )}
      {st?.feeds?.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {st.feeds.map(f => (
            <span key={f.type} title={f.name}>
              {f.syncing ? '⟳' : '✓'} {f.type}{f.version && ` ${f.version}`}
            </span>
          ))}
        </div>
      )}
      {!settled && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          The first start downloads and imports the feeds, which takes 15–60 minutes. This updates every 10 s
          {checkedAgo !== null && ` · checked ${checkedAgo}s ago`}.
        </div>
      )}
    </div>
  )
}

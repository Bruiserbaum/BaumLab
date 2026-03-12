import React, { useState, useEffect, useCallback } from 'react'

const REFRESH_INTERVAL = 30_000

function ago(isoString) {
  if (!isoString) return 'Never'
  const diffMs = Date.now() - new Date(isoString + 'Z').getTime()
  const secs   = Math.floor(diffMs / 1000)
  if (secs < 60)  return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60)  return `${mins}m ago`
  const hrs  = Math.floor(mins / 60)
  return `${hrs}h ago`
}

const OVERALL_CONFIG = {
  operational: { bg: '#1a2e1a', border: '#238636', dot: '#3fb950', text: '#3fb950', label: 'All Systems Operational' },
  degraded:    { bg: '#2e2415', border: '#d29922', dot: '#e3b341', text: '#e3b341', label: 'Partial Outage'           },
  outage:      { bg: '#2e1515', border: '#da3633', dot: '#f85149', text: '#f85149', label: 'Major Outage'             },
  unknown:     { bg: '#161b22', border: '#30363d', dot: '#8b949e', text: '#8b949e', label: 'No Data'                  },
}

export default function StatusPage() {
  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [lastFetch, setLastFetch] = useState(null)
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000)

  const fetch_ = useCallback(async () => {
    try {
      const r = await fetch('/api/status/public')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData(await r.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
    setLastFetch(new Date())
    setCountdown(REFRESH_INTERVAL / 1000)
  }, [])

  useEffect(() => {
    fetch_()
    const interval = setInterval(fetch_, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetch_])

  // Countdown ticker
  useEffect(() => {
    const tick = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(tick)
  }, [])

  const cfg     = OVERALL_CONFIG[data?.overall ?? 'unknown']
  const overall = data?.overall ?? 'unknown'

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0d1117',
      color: '#e6edf3',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '40px 16px 80px',
    }}>

      {/* Header */}
      <div style={{ width: '100%', maxWidth: 680, marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.5px' }}>BaumLab</span>
          <span style={{ fontSize: 16, color: '#8b949e' }}>Status</span>
        </div>
        <div style={{ height: 1, background: '#21262d' }} />
      </div>

      {/* Overall banner */}
      <div style={{
        width: '100%', maxWidth: 680, marginBottom: 28,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: 8,
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <div style={{
          width: 12, height: 12, borderRadius: '50%',
          background: cfg.dot,
          boxShadow: overall !== 'unknown' ? `0 0 8px ${cfg.dot}` : 'none',
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 16, fontWeight: 600, color: cfg.text }}>{cfg.label}</span>
        {data && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8b949e' }}>
            {data.up}/{data.total} up
          </span>
        )}
      </div>

      {/* Monitor list */}
      <div style={{ width: '100%', maxWidth: 680 }}>
        {error && (
          <div style={{ color: '#f85149', fontSize: 14, marginBottom: 16 }}>
            Failed to load status: {error}
          </div>
        )}

        {!data && !error && (
          <div style={{ color: '#8b949e', fontSize: 14 }}>Loading…</div>
        )}

        {data?.monitors.map(m => {
          const isUp      = m.is_up === true
          const isDown    = m.is_up === false
          const isUnknown = m.is_up === null
          const dot  = isUp ? '#3fb950' : isDown ? '#f85149' : '#8b949e'
          const label = isUp ? 'Operational' : isDown ? 'Down' : 'No data'
          const latency = m.latency_ms != null ? `${Math.round(m.latency_ms)} ms` : ''

          return (
            <div key={m.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 16px',
              background: '#161b22',
              border: '1px solid #21262d',
              borderRadius: 6,
              marginBottom: 8,
            }}>
              {/* Status dot */}
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: dot,
                flexShrink: 0,
                boxShadow: isDown ? `0 0 6px ${dot}` : 'none',
              }} />

              {/* Name + protocol badge */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                <span style={{
                  marginLeft: 8,
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: '#8b949e',
                  background: '#21262d',
                  padding: '2px 6px',
                  borderRadius: 4,
                  letterSpacing: '0.5px',
                }}>
                  {m.protocol}
                </span>
              </div>

              {/* Latency */}
              {latency && (
                <span style={{ fontSize: 12, color: '#8b949e', flexShrink: 0 }}>{latency}</span>
              )}

              {/* Last checked */}
              <span style={{ fontSize: 12, color: '#8b949e', flexShrink: 0, minWidth: 64, textAlign: 'right' }}>
                {ago(m.checked_at)}
              </span>

              {/* Status label */}
              <span style={{
                fontSize: 12,
                fontWeight: 600,
                color: dot,
                flexShrink: 0,
                minWidth: 72,
                textAlign: 'right',
              }}>
                {label}
              </span>
            </div>
          )
        })}

        {data?.monitors.length === 0 && (
          <div style={{ color: '#8b949e', fontSize: 14, textAlign: 'center', padding: 32 }}>
            No monitors configured.
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 40, fontSize: 12, color: '#8b949e', textAlign: 'center' }}>
        {lastFetch && (
          <>Last updated {lastFetch.toLocaleTimeString()} · Refreshes in {countdown}s · </>
        )}
        <a href="/" style={{ color: '#8b949e', textDecoration: 'underline' }}>BaumLab Dashboard</a>
      </div>
    </div>
  )
}

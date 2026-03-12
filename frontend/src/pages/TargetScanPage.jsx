import React, { useState, useEffect, useRef } from 'react'
import { useApi } from '../auth'

const API = '/api/advanced-scan'
const POLL_MS = 3000

// ── Helpers ───────────────────────────────────────────────────────────────────

function Section({ title, content, accent }) {
  const [open, setOpen] = useState(true)
  if (!content) return null
  return (
    <div style={{ marginTop: 10 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px',
          color: accent || 'var(--text-muted)',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 9 }}>{open ? '▼' : '▶'}</span>
        {title}
      </div>
      {open && (
        <pre style={{
          margin: '6px 0 0', padding: '10px 12px',
          background: '#0d1117', border: '1px solid var(--border)',
          borderRadius: 4, fontSize: 11.5, lineHeight: 1.6,
          color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          maxHeight: 300, overflowY: 'auto',
        }}>
          {content.trim()}
        </pre>
      )}
    </div>
  )
}

function PortCard({ p }) {
  const hasTls = p.ssl_cert || p.tls_ciphers
  const hasSmb = p.smb_security || p.smb2_security
  const hasHttp = p.http_title || p.http_server

  // Infer category color
  const isSecure  = p.service?.match(/https|ftps|imaps|smtps|ldaps/) || p.port === 443 || p.port === 8443
  const isInsecure = p.service?.match(/^(telnet|ftp|smtp|http|imap|pop3|ldap|smb)$/) && !isSecure
  const dotColor  = isInsecure ? '#e3b341' : '#3fb950'

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderLeft: `3px solid ${dotColor}`,
      borderRadius: 6, padding: '12px 16px', marginBottom: 10,
    }}>
      {/* Port header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 15 }}>
          {p.port}<span style={{ color: 'var(--text-muted)', fontSize: 12 }}>/{p.protocol}</span>
        </span>
        <span style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
          background: 'var(--border)', color: 'var(--text-muted)', padding: '2px 6px', borderRadius: 4,
        }}>
          {p.service || 'unknown'}
        </span>
        {p.product && (
          <span style={{ fontSize: 13, color: 'var(--text)' }}>
            {p.product}{p.version ? ` ${p.version}` : ''}
          </span>
        )}
        {p.extra && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.extra}</span>
        )}
        {hasTls && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#3fb950', fontWeight: 600 }}>🔒 TLS</span>
        )}
      </div>

      {/* Inline banner (short) */}
      {p.banner && p.banner.length <= 120 && (
        <div style={{ marginTop: 6, fontSize: 12, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
          {p.banner}
        </div>
      )}

      {/* Sections */}
      {p.banner && p.banner.length > 120 && (
        <Section title="Banner" content={p.banner} />
      )}
      {p.ssl_cert && (
        <Section title="SSL Certificate" content={p.ssl_cert} accent="#3fb950" />
      )}
      {p.tls_ciphers && (
        <Section title="TLS / Cipher Suites" content={p.tls_ciphers} accent="#3fb950" />
      )}
      {hasSmb && (
        <Section
          title="SMB"
          content={[p.smb_security, p.smb2_security].filter(Boolean).join('\n\n')}
          accent="#e3b341"
        />
      )}
      {hasHttp && (
        <Section
          title="HTTP"
          content={[p.http_title && `Title: ${p.http_title}`, p.http_server && `Server: ${p.http_server}`].filter(Boolean).join('\n')}
          accent="#1f6feb"
        />
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TargetScanPage() {
  const api = useApi()
  const [presets, setPresets]   = useState({})
  const [target, setTarget]     = useState('')
  const [preset, setPreset]     = useState('common')
  const [customPorts, setCustomPorts] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [scanState, setScanState] = useState(null)
  const [elapsed, setElapsed]   = useState(0)
  const pollRef  = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => {
    api(`${API}/presets`).then(r => r.json()).then(setPresets)
    return () => { clearInterval(pollRef.current); clearInterval(timerRef.current) }
  }, [])

  async function poll() {
    const r    = await api(`${API}/status`)
    const data = await r.json()
    setScanState(data)
    if (!data.running) {
      clearInterval(pollRef.current)
      clearInterval(timerRef.current)
    }
  }

  async function startScan(e) {
    e.preventDefault()
    const ports = useCustom ? customPorts.trim() : (presets[preset] || presets['common'] || '')
    const r = await api(`${API}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: target.trim(), ports }),
    })
    await r.json()
    setElapsed(0)
    clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
    clearInterval(pollRef.current)
    pollRef.current = setInterval(poll, POLL_MS)
    poll()
  }

  const result   = scanState?.result
  const openPorts = result?.ports ?? []
  const running   = scanState?.running

  return (
    <div>
      <h1>Target Scan</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: -8, marginBottom: 20, fontSize: 14 }}>
        Deep service + vulnerability scan — version detection, SSL/TLS ciphers,
        certificate info, SMB negotiation, and service banners.
      </p>

      {/* ── Scan form ─────────────────────────────────────────── */}
      <form className="card" onSubmit={startScan}
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 24 }}>

        <label>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Target IP or Hostname</div>
          <input
            required value={target} onChange={e => setTarget(e.target.value)}
            placeholder="192.168.1.1" style={{ width: 200 }}
          />
        </label>

        <label>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Port Preset</div>
          <select value={preset} onChange={e => { setPreset(e.target.value); setUseCustom(false) }}
            disabled={useCustom}>
            {Object.keys(presets).map(k => (
              <option key={k} value={k}>
                {k === 'common' ? 'Common Services (30 ports)' :
                 k === 'top-100' ? 'Top 100' :
                 k === 'top-1000' ? 'Top 1000' : k}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={useCustom} onChange={e => setUseCustom(e.target.checked)}
              style={{ marginRight: 5 }} />
            Custom ports
          </div>
          <input
            value={customPorts} onChange={e => setCustomPorts(e.target.value)}
            disabled={!useCustom} placeholder="e.g. 22,80,443 or 1-1024"
            style={{ width: 200, opacity: useCustom ? 1 : 0.4 }}
          />
        </label>

        <button type="submit" disabled={running || !target.trim()}>
          {running ? '⏳ Scanning…' : '▶ Run Scan'}
        </button>
      </form>

      {/* ── Progress ──────────────────────────────────────────── */}
      {running && (
        <div style={{
          padding: '12px 16px', marginBottom: 20,
          background: 'rgba(31,111,235,0.1)', border: '1px solid var(--accent)',
          borderRadius: 6, fontSize: 13, color: 'var(--accent)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
          Scanning <strong>{scanState?.target}</strong> — {elapsed}s elapsed.
          Service detection + NSE scripts may take 1–3 minutes.
        </div>
      )}

      {/* ── Results ───────────────────────────────────────────── */}
      {!running && result && (
        <>
          {/* Summary bar */}
          <div style={{
            display: 'flex', gap: 24, padding: '12px 16px', marginBottom: 20,
            background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
            flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>TARGET</div>
              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{result.target}</span>
              {result.hostname && (
                <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                  ({result.hostname})
                </span>
              )}
            </div>
            {result.os_guess && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>OS GUESS</div>
                <span style={{ fontSize: 13 }}>{result.os_guess}</span>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>OPEN PORTS</div>
              <span style={{ fontWeight: 700, color: openPorts.length ? '#3fb950' : 'var(--text-muted)' }}>
                {openPorts.length}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>TLS PORTS</div>
              <span style={{ fontWeight: 700, color: '#3fb950' }}>
                {openPorts.filter(p => p.ssl_cert || p.tls_ciphers).length}
              </span>
            </div>
            {openPorts.some(p => p.smb_security || p.smb2_security) && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>SMB</div>
                <span style={{ fontWeight: 700, color: '#e3b341' }}>detected</span>
              </div>
            )}
            <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
              Scanned in {
                scanState.finished_at && scanState.started_at
                  ? `${Math.round((new Date(scanState.finished_at) - new Date(scanState.started_at)) / 1000)}s`
                  : '—'
              }
            </div>
          </div>

          {/* Error */}
          {result.error && (
            <div style={{ color: 'var(--red)', marginBottom: 16, fontSize: 14 }}>✗ {result.error}</div>
          )}

          {/* Open port cards */}
          {openPorts.length === 0 && !result.error && (
            <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>No open ports found.</div>
          )}
          {openPorts.map(p => (
            <PortCard key={`${p.port}-${p.protocol}`} p={p} />
          ))}
        </>
      )}
    </div>
  )
}

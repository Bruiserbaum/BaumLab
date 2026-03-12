import React, { useState, useEffect, useRef } from 'react'
import { useApi } from '../auth'

const API = '/api/external-scan'
const POLL_INTERVAL = 2000

export default function ExternalScanPage() {
  const api = useApi()

  // External IP
  const [extIp, setExtIp]       = useState(null)
  const [ipLoading, setIpLoading] = useState(false)
  const [ipError, setIpError]   = useState(null)

  // Port scan
  const [scanIp, setScanIp]       = useState('')
  const [scanState, setScanState] = useState(null)
  const pollRef = useRef(null)

  // DNS
  const [domain, setDomain]         = useState('')
  const [dnsResult, setDnsResult]   = useState(null)
  const [dnsLoading, setDnsLoading] = useState(false)

  // Load external IP on mount
  useEffect(() => {
    fetchExternalIp()
    return () => clearInterval(pollRef.current)
  }, [])

  // Auto-fill scan field when external IP loads
  useEffect(() => {
    if (extIp && !scanIp) setScanIp(extIp)
  }, [extIp])

  async function fetchExternalIp() {
    setIpLoading(true)
    setIpError(null)
    try {
      const r = await api(`${API}/ip`)
      const data = await r.json()
      if (data.ip) {
        setExtIp(data.ip)
      } else {
        setIpError(data.error || 'Unknown error')
      }
    } catch (e) {
      setIpError(String(e))
    } finally {
      setIpLoading(false)
    }
  }

  async function startPortScan(e) {
    e.preventDefault()
    if (!scanIp.trim()) return
    const r = await api(`${API}/ports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: scanIp.trim() }),
    })
    await r.json()
    // Begin polling for results
    clearInterval(pollRef.current)
    pollRef.current = setInterval(pollPortScan, POLL_INTERVAL)
    pollPortScan()
  }

  async function pollPortScan() {
    const r    = await api(`${API}/ports/status`)
    const data = await r.json()
    setScanState(data)
    if (!data.running) clearInterval(pollRef.current)
  }

  async function dnsLookup(e) {
    e.preventDefault()
    if (!domain.trim()) return
    setDnsLoading(true)
    setDnsResult(null)
    try {
      const r    = await api(`${API}/dns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() }),
      })
      setDnsResult(await r.json())
    } finally {
      setDnsLoading(false)
    }
  }

  const openPorts = scanState?.results?.filter(p => p.open) ?? []

  return (
    <div>
      <h1>External Scan</h1>

      {/* ── External IP ─────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
              YOUR EXTERNAL IP
            </div>
            {ipLoading && <span style={{ color: 'var(--text-muted)' }}>Detecting…</span>}
            {ipError  && <span style={{ color: 'var(--red)', fontSize: 13 }}>{ipError}</span>}
            {extIp    && (
              <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: 'var(--accent)' }}>
                {extIp}
              </span>
            )}
          </div>
          <button className="secondary" onClick={fetchExternalIp} disabled={ipLoading} style={{ alignSelf: 'flex-end' }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Port Scan ────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>Port Scan</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0, marginBottom: 12 }}>
          Scans common ports on the target IP from the server. Results reflect what is reachable
          from the server's network perspective.
        </p>
        <form onSubmit={startPortScan} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Target IP</div>
            <input
              value={scanIp}
              onChange={e => setScanIp(e.target.value)}
              placeholder="e.g. 1.2.3.4"
              style={{ width: 180 }}
            />
          </label>
          <button type="submit" disabled={scanState?.running || !scanIp.trim()}>
            {scanState?.running ? 'Scanning…' : 'Scan Ports'}
          </button>
          {extIp && scanIp !== extIp && (
            <button type="button" className="secondary" onClick={() => setScanIp(extIp)}>
              Use External IP
            </button>
          )}
        </form>

        {scanState && (
          <>
            {scanState.running && (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
                ⏳ Scanning {scanState.ip} — checking {COMMON_PORTS_COUNT} ports…
              </div>
            )}

            {!scanState.running && scanState.results.length > 0 && (
              <>
                <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--text-muted)' }}>
                  {openPorts.length} open port{openPorts.length !== 1 ? 's' : ''} found on{' '}
                  <strong style={{ color: 'var(--text)' }}>{scanState.ip}</strong>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Port</th>
                      <th>Service</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanState.results.map(p => (
                      <tr key={p.port}>
                        <td style={{ fontFamily: 'monospace' }}>{p.port}</td>
                        <td>{p.service}</td>
                        <td>
                          <span className={`badge ${p.open ? 'badge-green' : 'badge-gray'}`}>
                            {p.open ? 'Open' : 'Closed'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>

      {/* ── DNS Lookup ───────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>DNS Lookup</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0, marginBottom: 12 }}>
          Resolve a domain name and check whether it points to your external IP.
        </p>
        <form onSubmit={dnsLookup} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Domain</div>
            <input
              value={domain}
              onChange={e => setDomain(e.target.value)}
              placeholder="e.g. mysite.example.com"
              style={{ width: 260 }}
            />
          </label>
          <button type="submit" disabled={dnsLoading || !domain.trim()}>
            {dnsLoading ? 'Looking up…' : 'Lookup'}
          </button>
        </form>

        {dnsResult && (
          <div>
            {dnsResult.error ? (
              <div style={{ color: 'var(--red)', fontSize: 13 }}>
                ✗ {dnsResult.error}
              </div>
            ) : (
              <>
                <table style={{ marginBottom: 0 }}>
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Resolved IP</th>
                      <th>Matches External IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dnsResult.resolved_ips.map(ip => {
                      const matches = extIp && ip === extIp
                      return (
                        <tr key={ip}>
                          {/* only show domain in first row */}
                          <td style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                            {dnsResult.domain}
                          </td>
                          <td style={{ fontFamily: 'monospace' }}>{ip}</td>
                          <td>
                            {extIp == null ? (
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                                (external IP unknown)
                              </span>
                            ) : (
                              <span className={`badge ${matches ? 'badge-green' : 'badge-red'}`}>
                                {matches ? '✓ Match' : '✗ No match'}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {dnsResult.resolved_ips.length === 0 && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No addresses resolved.</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Used in template literal above
const COMMON_PORTS_COUNT = 20

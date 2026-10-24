import React, { useEffect, useState } from 'react'
import { useApi, useAuth } from '../auth'

const API = '/api/certs'

const LEVELS = {
  ok:       ['green', d => `${d} days`],
  warn:     ['yellow', d => `${d} days`],
  critical: ['red', d => `${d} days`],
  expired:  ['red', d => `expired ${-d}d ago`],
  error:    ['gray', () => 'unreachable'],
}

export default function CertificatesPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [rows, setRows] = useState(null)
  const [checking, setChecking] = useState(false)
  const [host, setHost] = useState('')
  const [error, setError] = useState('')

  async function load() {
    const r = await api(`${API}/`)
    if (r.ok) setRows(await r.json())
  }
  useEffect(() => { load() }, [])

  async function checkAll() {
    setChecking(true)
    await api(`${API}/check`, { method: 'POST' })
    await load()
    setChecking(false)
  }

  async function checkOne(id) {
    const r = await api(`${API}/${id}/check`, { method: 'POST' })
    if (r.ok) {
      const updated = await r.json()
      setRows(list => list.map(x => x.id === id ? updated : x))
    }
  }

  async function add(e) {
    e.preventDefault()
    setError('')
    const r = await api(`${API}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host }),
    })
    if (!r.ok) { setError((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`); return }
    setHost('')
    load()
  }

  async function remove(c) {
    if (!confirm(`Stop tracking ${c.host}:${c.port}?`)) return
    await api(`${API}/${c.id}`, { method: 'DELETE' })
    load()
  }

  if (!rows) return <div><h1>Certificates</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const unchecked = rows.filter(r => !r.checked_at).length

  return (
    <div>
      <h1>Certificates</h1>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-8px 0 16px' }}>
        TLS certificates of every service with an https URL or protocol, plus hosts added here. Checked daily;
        alerts at 21 and 7 days before expiry and on expiry.
      </p>

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <button onClick={checkAll} disabled={checking}>{checking ? 'Checking…' : '⟳ Check all now'}</button>
        {isAdmin && (
          <form onSubmit={add} style={{ display: 'flex', gap: 6 }}>
            <input required placeholder="host or host:port" value={host} onChange={e => setHost(e.target.value)} style={{ width: 220 }} />
            <button type="submit" className="secondary">+ Track host</button>
          </form>
        )}
        {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
        {unchecked > 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>{unchecked} not checked yet</span>}
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          Nothing to track yet — give services an https:// access URL, or add a host above.
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>Expires</th><th>Endpoint</th><th>Used by</th><th>Issuer</th><th>Valid until</th><th>Trust</th><th>Checked</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const [color, text] = LEVELS[c.level]
              return (
                <tr key={c.id}>
                  <td>{c.checked_at ? <span className={`badge badge-${color}`} title={c.error || ''}>{text(c.days_left)}</span>
                                    : <span className="badge badge-gray">not checked</span>}</td>
                  <td>
                    <div style={{ fontFamily: 'monospace' }}>{c.host}{c.port !== 443 ? `:${c.port}` : ''}</div>
                    {c.sans && <div style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 320 }} title={c.sans}>
                      {c.sans.length > 60 ? c.sans.slice(0, 60) + '…' : c.sans}</div>}
                    {c.error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{c.error}</div>}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {c.services.join(', ') || (c.manual ? <span className="badge badge-gray">added by hand</span> : '—')}
                  </td>
                  <td>{c.issuer || '—'}</td>
                  <td style={{ fontSize: 12 }}>{c.not_after ? new Date(c.not_after + 'Z').toLocaleDateString() : '—'}</td>
                  <td>
                    {c.trusted === true && <span className="badge badge-green">trusted</span>}
                    {c.trusted === false && <span className="badge badge-yellow" title={c.verify_error || ''}>untrusted</span>}
                    {c.trusted == null && '—'}
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {c.checked_at ? new Date(c.checked_at + 'Z').toLocaleString() : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="secondary" onClick={() => checkOne(c.id)}>⟳</button>
                      {isAdmin && c.manual && (
                        <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(c)}>✕</button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

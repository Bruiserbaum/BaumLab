import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, useAuth } from '../auth'

const REFRESH_MS = 30_000
const SEVERITY = {
  critical: { color: 'var(--red)', icon: '●' },
  warning:  { color: 'var(--yellow)', icon: '●' },
  info:     { color: '#58a6ff', icon: '●' },
}

function ago(v) {
  if (!v) return ''
  const mins = Math.round((Date.now() - new Date(v + 'Z').getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 2880) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

/** A summary tile: big number, label, and up to two qualifiers. Whole tile links to its section. */
function Tile({ to, title, value, sub, tone = 'ok', extra }) {
  const border = tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--yellow)' : 'var(--border)'
  return (
    <Link to={to} className="card" style={{ marginBottom: 0, textDecoration: 'none', color: 'var(--text)',
      borderColor: border, display: 'block' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 600, margin: '4px 0' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub}</div>
      {extra && <div style={{ fontSize: 12, marginTop: 4, color: tone === 'bad' ? 'var(--red)' : 'var(--yellow)' }}>{extra}</div>}
    </Link>
  )
}

export default function DashboardPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [d, setD] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    const r = await api('/api/dashboard/')
    if (r.ok) { setD(await r.json()); setError('') }
    else setError(`Could not load the dashboard (HTTP ${r.status})`)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [])

  if (!d) return <div><h1>Dashboard</h1><p style={{ color: error ? 'var(--red)' : 'var(--text-muted)' }}>{error || 'Loading…'}</p></div>

  const b = d.backups
  const backupTotal = b.ok + b.stale + b.failing + b.none
  const c = d.certs

  return (
    <div>
      <h1>Dashboard</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 20 }}>
        <Tile to="/monitors" title="Monitors" value={d.monitors.total ? `${d.monitors.up}/${d.monitors.total}` : '—'}
          sub={d.monitors.total ? 'up' : 'no monitors yet'}
          tone={d.monitors.down ? 'bad' : 'ok'} extra={d.monitors.down ? `${d.monitors.down} down` : null} />
        <Tile to="/services" title="Services" value={d.services.total}
          sub={`${d.services.proxied} proxied · ${d.services.sso} behind SSO`}
          tone={d.services.exposed_without_sso ? 'warn' : 'ok'}
          extra={d.services.exposed_without_sso ? `${d.services.exposed_without_sso} public without SSO` : null} />
        <Tile to={isAdmin ? '/backups' : '/services'} title="Backups" value={backupTotal ? `${b.ok}/${backupTotal}` : '—'}
          sub="services protected"
          tone={b.failing ? 'bad' : b.stale || b.none ? 'warn' : 'ok'}
          extra={[b.failing && `${b.failing} failing`, b.stale && `${b.stale} stale`, b.none && `${b.none} without backup`].filter(Boolean).join(' · ') || null} />
        <Tile to="/certificates" title="Certificates" value={c.ok + c.expiring + c.expired + c.error || '—'}
          sub={`${c.ok} valid > 21 days`}
          tone={c.expired ? 'bad' : c.expiring ? 'warn' : 'ok'}
          extra={[c.expired && `${c.expired} expired`, c.expiring && `${c.expiring} expiring soon`].filter(Boolean).join(' · ') || null} />
        <Tile to="/devices" title="Devices" value={`${d.devices.online}/${d.devices.total}`} sub="online"
          tone={d.devices.new_count ? 'warn' : 'ok'}
          extra={d.devices.new_count ? `${d.devices.new_count} new this week` : null} />
        <Tile to="/portainer" title="Docker" value={d.containers.total ? `${d.containers.running}/${d.containers.total}` : '—'}
          sub={d.containers.total ? 'containers running' : 'add Portainer on the Docker page'}
          tone={d.containers.unhealthy ? 'warn' : 'ok'}
          extra={d.containers.unhealthy ? `${d.containers.unhealthy} restarting / dead` : null} />
        <Tile to="/settings" title="BaumLab" value={`v${d.version.current}`}
          sub={d.version.update_available ? `v${d.version.latest} available` : d.version.latest ? 'up to date' : 'update check pending'}
          tone={d.version.update_available ? 'warn' : 'ok'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        <section className="card" style={{ marginBottom: 0 }}>
          <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>
            Needs attention {d.attention.length > 0 && <span className="badge badge-gray">{d.attention.length}</span>}
          </h2>
          {d.attention.length === 0 ? (
            <div style={{ color: 'var(--green)', fontSize: 14 }}>✓ All clear</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
              {d.attention.map((a, i) => (
                <Link key={i} to={a.link} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--text)', textDecoration: 'none' }}>
                  <span style={{ color: SEVERITY[a.severity].color }}>{SEVERITY[a.severity].icon}</span>
                  {a.text}
                </Link>
              ))}
            </div>
          )}
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {d.devices.new_this_week.length > 0 && (
            <section className="card" style={{ marginBottom: 0 }}>
              <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>New devices this week</h2>
              {d.devices.new_this_week.map(n => (
                <div key={n.ip} style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 4 }}>
                  <code>{n.ip}</code><span>{n.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{ago(n.first_seen)}</span>
                </div>
              ))}
            </section>
          )}
          {isAdmin && (
            <section className="card" style={{ marginBottom: 0 }}>
              <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>
                Recent alerts <Link to="/alerts" style={{ fontSize: 12, color: 'var(--accent)', marginLeft: 6 }}>all →</Link>
              </h2>
              {d.recent_alerts.length === 0
                ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No alerts yet.</div>
                : d.recent_alerts.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 4 }}>
                    <span style={{ color: SEVERITY[a.severity]?.color }}>●</span>
                    <span>{a.title}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ago(a.at)}</span>
                  </div>
                ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

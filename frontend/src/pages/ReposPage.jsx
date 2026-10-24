import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, useAuth } from '../auth'

const API = '/api'

const GROUPINGS = {
  source:   { label: 'Source',   key: r => r.source },
  owner:    { label: 'Owner',    key: r => `${r.owner} (${r.source})` },
  language: { label: 'Language', key: r => r.language || 'Unknown' },
  none:     { label: 'None',     key: () => 'All repositories' },
}

function ago(iso) {
  if (!iso) return '—'
  const t = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z').getTime()
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  if (days < 60) return `${days}d ago`
  if (days < 730) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export default function ReposPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [data, setData]         = useState(null)
  const [search, setSearch]     = useState('')
  const [groupBy, setGroupBy]   = useState('source')
  const [showForks, setShowForks] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  async function load() {
    const r = await api(`${API}/repos/`)
    if (r.ok) setData(await r.json())
  }

  async function refresh() {
    setRefreshing(true)
    await api(`${API}/repos/refresh`, { method: 'POST' })
    await load()
    setRefreshing(false)
  }

  useEffect(() => { load() }, [])

  const repos = data?.repos ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return repos.filter(r =>
      (showForks || !r.fork) && (showArchived || !r.archived) &&
      (!q || [r.full_name, r.description, r.language, r.release_tag].some(v => v && v.toLowerCase().includes(q))))
  }, [repos, search, showForks, showArchived])

  const groups = useMemo(() => {
    const keyFn = GROUPINGS[groupBy].key
    const map = new Map()
    for (const r of filtered) {
      const k = keyFn(r)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(r)
    }
    for (const list of map.values()) list.sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''))
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered, groupBy])

  if (!data) return <div><h1>Repositories</h1><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  if (data.sources.length === 0) return (
    <div>
      <h1>Repositories</h1>
      <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
        No repository sources yet.{' '}
        {isAdmin
          ? <>Add GitHub, GitHub Enterprise, Gitea or Forgejo in <Link to="/settings" style={{ color: 'var(--accent)' }}>Settings → Repository Sources</Link>.</>
          : 'Ask an admin to add one in Settings.'}
      </div>
    </div>
  )

  const forks = repos.filter(r => r.fork).length
  const archived = repos.filter(r => r.archived).length

  return (
    <div>
      <h1>Repositories</h1>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {data.sources.map(s => (
          <div key={s.name} className="card" style={{ marginBottom: 0, padding: '10px 16px', minWidth: 140,
            borderColor: s.error ? 'var(--red)' : 'var(--border)' }} title={s.error || ''}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{s.count}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.name}</div>
            {s.error
              ? <div style={{ fontSize: 11, color: 'var(--red)', maxWidth: 220 }}>✗ {s.error}</div>
              : s.checked_at && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>checked {ago(s.checked_at)}</div>}
          </div>
        ))}
        <div className="card" style={{ marginBottom: 0, padding: '10px 16px', minWidth: 110 }}>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{repos.filter(r => r.release_tag).length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>with releases</div>
        </div>
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 8 }}>Group by</span>
        <select value={groupBy} onChange={e => setGroupBy(e.target.value)}>
          {Object.entries(GROUPINGS).map(([k, g]) => <option key={k} value={k}>{g.label}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={showForks} onChange={e => setShowForks(e.target.checked)} />
          Forks ({forks})
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          Archived ({archived})
        </label>
        <button className="secondary" style={{ marginLeft: 'auto' }} onClick={refresh} disabled={refreshing || data.refreshing}>
          {refreshing || data.refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>

      {groups.map(([group, items]) => (
        <div key={group} style={{ marginBottom: 24 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {group}
            <span className="badge badge-gray">{items.length}</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th>Description</th>
                <th>Language</th>
                <th>Last updated</th>
                <th>Latest release</th>
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={`${r.source}:${r.full_name}`} style={r.archived ? { opacity: 0.55 } : {}}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <a href={r.html_url} target="_blank" rel="noreferrer" style={{ color: 'var(--text)', fontWeight: 500 }}>
                      {groupBy === 'owner' ? r.name : r.full_name}
                    </a>
                    {r.private && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>private</span>}
                    {r.fork && <span className="badge badge-gray" style={{ marginLeft: 6 }}>fork</span>}
                    {r.archived && <span className="badge badge-gray" style={{ marginLeft: 6 }}>archived</span>}
                  </td>
                  <td style={{ color: 'var(--text-muted)', maxWidth: 420 }}>{r.description || ''}</td>
                  <td>{r.language || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }} title={r.last_activity || ''}>{ago(r.last_activity)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.release_tag ? (
                      <>
                        <a href={r.release_url} target="_blank" rel="noreferrer"
                          style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>{r.release_tag}</a>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
                          {ago(r.release_published_at)}
                        </span>
                      </>
                    ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {repos.length > 0 && filtered.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No repositories match.</div>
      )}
      {repos.length === 0 && !data.sources.some(s => s.error) && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          Nothing fetched yet — click Refresh.
        </div>
      )}
    </div>
  )
}

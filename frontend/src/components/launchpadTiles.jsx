import React from 'react'
import { AppIcon } from './IconPicker'

/** Turn API services + bookmarks into one tile list. */
export function buildTiles(services, bookmarks) {
  return [
    ...services.map(s => ({ ...s, kind: 'service', key: `s${s.id}`, launchpad: s.launchpad ?? true,
                            subtitle: s.host || (s.url || '').replace(/^https?:\/\//, '') })),
    ...bookmarks.map(b => ({ ...b, kind: 'bookmark', key: `b${b.id}`, launchpad: true, status: null,
                             subtitle: b.description || (b.url || '').replace(/^https?:\/\//, '') })),
  ]
}

/** [[group, tiles], …] in the saved group order (unknown groups after, A–Z), tiles by position then name. */
export function groupTiles(tiles, groupOrder = []) {
  const map = new Map()
  for (const t of tiles) {
    if (!map.has(t.group)) map.set(t.group, [])
    map.get(t.group).push(t)
  }
  const rank = g => { const i = groupOrder.indexOf(g); return i === -1 ? Infinity : i }
  for (const list of map.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
  return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}

export function matches(tile, q) {
  const s = q.trim().toLowerCase()
  return !s || [tile.name, tile.group, tile.subtitle].some(v => v && v.toLowerCase().includes(s))
}

/** Icon, name, subtitle and (optional) up/down dot. */
export function TileBody({ tile, size = 40 }) {
  return (
    <>
      <AppIcon icon={tile.icon} name={tile.name} size={size} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tile.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {tile.subtitle}
        </div>
      </div>
      {tile.status != null && (
        <span title={tile.status ? 'Up' : 'Down'} style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
          background: tile.status ? 'var(--green)' : 'var(--red)', boxShadow: tile.status ? 'none' : '0 0 6px var(--red)' }} />
      )}
    </>
  )
}

export const tileStyle = { display: 'flex', alignItems: 'center', gap: 12, padding: 12, marginBottom: 0,
                           color: 'var(--text)', textDecoration: 'none', minHeight: 64 }

/** Read-only tile that opens its URL. */
export function TileLink({ tile }) {
  return tile.url
    ? <a className="card" href={tile.url} target="_blank" rel="noreferrer" style={tileStyle}><TileBody tile={tile} /></a>
    : <div className="card" style={{ ...tileStyle, opacity: 0.5 }} title="No URL set"><TileBody tile={tile} /></div>
}

export const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }

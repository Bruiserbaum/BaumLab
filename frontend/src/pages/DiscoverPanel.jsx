import React, { useEffect, useState } from 'react'

const API = '/api'
const PROTOCOLS = ['http', 'https', 'tcp', 'udp', 'ssh']

const cell = { padding: '4px 6px' }
const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: 12 }

/** Review-and-edit list of service suggestions from Portainer containers and device port scans. */
export default function DiscoverPanel({ api, devices, categories, onClose, onAdded, onDevicesChanged }) {
  const [data, setData]         = useState(null)
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [createMonitors, setCreateMonitors] = useState(true)
  const [scanProgress, setScanProgress] = useState(null)   // { done, total } while port-scanning
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  async function load() {
    setLoading(true)
    const r = await api(`${API}/services/discover`)
    if (r.ok) {
      const d = await r.json()
      setData(d)
      setRows(d.suggestions.map(s => ({ ...s, port: s.port ?? '', vlan: s.vlan ?? '', category: s.category ?? '' })))
    } else {
      setError(`Could not load suggestions (HTTP ${r.status})`)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Port-scan devices one at a time so progress is visible and the API isn't flooded
  async function scanDevices(onlyMissing) {
    const targets = devices.filter(d => !onlyMissing || !d.open_ports || d.open_ports === '[]')
    setScanProgress({ done: 0, total: targets.length })
    for (let i = 0; i < targets.length; i++) {
      await api(`${API}/scan/ports/${targets[i].id}?port_range=${encodeURIComponent(data.scan_ports)}`, { method: 'POST' })
        .catch(() => {})
      setScanProgress({ done: i + 1, total: targets.length })
    }
    setScanProgress(null)
    onDevicesChanged?.()
    await load()
  }

  function update(key, field, value) {
    setRows(rs => rs.map(r => r.key === key ? { ...r, [field]: value } : r))
  }

  function selectAll(value) {
    setRows(rs => rs.map(r => ({ ...r, selected: value })))
  }

  async function addSelected() {
    setSaving(true); setError('')
    const items = rows.filter(r => r.selected).map(r => ({
      name: r.name.trim(),
      category: r.category.trim() || null,
      host: r.host?.trim() || null,
      platform: r.platform || null,
      ip: r.ip?.trim() || null,
      port: r.port !== '' ? +r.port : null,
      protocol: r.protocol,
      vlan: r.vlan !== '' ? +r.vlan : null,
      notes: r.notes || null,
      create_monitor: createMonitors,
      container_connection: r.container_connection ?? null,
      container_endpoint_id: r.container_endpoint_id ?? null,
      container_name: r.container_name ?? null,
      // SSH rows land on the Terminal page too (admins; add the login there)
      create_terminal_host: r.protocol === 'ssh',
    }))
    const r = await api(`${API}/services/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    })
    setSaving(false)
    if (!r.ok) { setError((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`); return }
    onAdded(items.length)
  }

  const selectedCount = rows.filter(r => r.selected).length
  const missing = data?.devices_without_ports ?? 0

  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>Discover services</h2>
        {data && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {data.containers_seen} running container{data.containers_seen !== 1 ? 's' : ''} from Portainer ·{' '}
            {data.devices_seen} device{data.devices_seen !== 1 ? 's' : ''}
            {missing > 0 && <> · <span style={{ color: 'var(--yellow)' }}>{missing} without port data</span></>}
          </span>
        )}
        <button type="button" className="secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>

      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Suggestions skip anything already in your inventory. Untick what's wrong, fix names and details,
        then add. Everything stays editable afterwards.
      </p>

      {data && devices.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          {scanProgress ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Port-scanning devices… {scanProgress.done} / {scanProgress.total}
            </span>
          ) : (
            <>
              {missing > 0 && (
                <button type="button" className="secondary" onClick={() => scanDevices(true)}>
                  Port-scan {missing} device{missing !== 1 ? 's' : ''} without data
                </button>
              )}
              <button type="button" className="secondary" onClick={() => scanDevices(false)}>
                Rescan all {devices.length} devices
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Checks {data.scan_ports.split(',').length} well-known service ports per device.
              </span>
            </>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Looking…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No new suggestions. Add a Portainer connection on the Docker page, or port-scan your devices above.
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={cell}>
                    <input type="checkbox" checked={selectedCount === rows.length}
                      onChange={e => selectAll(e.target.checked)} />
                  </th>
                  <th style={cell}>Name</th>
                  <th style={cell}>Category</th>
                  <th style={cell}>Host</th>
                  <th style={cell}>IP</th>
                  <th style={cell}>Port</th>
                  <th style={cell}>Protocol</th>
                  <th style={cell}>VLAN</th>
                  <th style={cell}>Found by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key} style={{ opacity: r.selected ? 1 : 0.5 }} title={r.notes || ''}>
                    <td style={cell}>
                      <input type="checkbox" checked={r.selected} onChange={e => update(r.key, 'selected', e.target.checked)} />
                    </td>
                    <td style={{ ...cell, minWidth: 160 }}>
                      <input style={inputStyle} value={r.name} onChange={e => update(r.key, 'name', e.target.value)} />
                    </td>
                    <td style={{ ...cell, minWidth: 120 }}>
                      <input style={inputStyle} list="disc-categories" value={r.category}
                        onChange={e => update(r.key, 'category', e.target.value)} />
                    </td>
                    <td style={{ ...cell, minWidth: 110 }}>
                      <input style={inputStyle} value={r.host ?? ''} onChange={e => update(r.key, 'host', e.target.value)} />
                    </td>
                    <td style={{ ...cell, minWidth: 110 }}>
                      <input style={{ ...inputStyle, fontFamily: 'monospace' }} value={r.ip ?? ''}
                        onChange={e => update(r.key, 'ip', e.target.value)} />
                    </td>
                    <td style={{ ...cell, width: 70 }}>
                      <input style={inputStyle} type="number" value={r.port} onChange={e => update(r.key, 'port', e.target.value)} />
                    </td>
                    <td style={cell}>
                      <select style={{ fontSize: 12, padding: '4px 6px' }} value={r.protocol}
                        onChange={e => update(r.key, 'protocol', e.target.value)}>
                        {PROTOCOLS.map(p => <option key={p}>{p}</option>)}
                      </select>
                    </td>
                    <td style={{ ...cell, width: 60 }}>
                      <input style={inputStyle} type="number" value={r.vlan} onChange={e => update(r.key, 'vlan', e.target.value)} />
                    </td>
                    <td style={cell}>
                      <span className={`badge badge-${r.source === 'docker' ? 'blue' : 'gray'}`}>
                        {r.source === 'docker' ? 'Docker' : 'Port scan'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" onClick={addSelected} disabled={saving || selectedCount === 0}>
              {saving ? 'Adding…' : `Add ${selectedCount} service${selectedCount !== 1 ? 's' : ''}`}
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={createMonitors} onChange={e => setCreateMonitors(e.target.checked)} />
              Also create a health monitor for each
            </label>
          </div>
        </>
      )}
      <datalist id="disc-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
    </div>
  )
}

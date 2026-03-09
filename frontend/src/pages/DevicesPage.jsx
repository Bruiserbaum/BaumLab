import React, { useEffect, useState } from 'react'
import { useApi } from '../auth'

const API = '/api'

export default function DevicesPage() {
  const api = useApi()
  const [devices, setDevices] = useState([])
  const [cidr, setCidr] = useState('192.168.1.0/24')
  const [scanning, setScanning] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editData, setEditData] = useState({})

  async function loadDevices() {
    const r = await api(`${API}/devices/`)
    setDevices(await r.json())
  }

  useEffect(() => { loadDevices() }, [])

  async function startScan() {
    setScanning(true)
    await api(`${API}/scan/network?cidr=${encodeURIComponent(cidr)}`, { method: 'POST' })
    // Poll until devices stabilise
    setTimeout(async () => { await loadDevices(); setScanning(false) }, 5000)
  }

  async function saveEdit(id) {
    await api(`${API}/devices/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editData),
    })
    setEditId(null)
    await loadDevices()
  }

  async function deleteDevice(id) {
    if (!confirm('Delete this device?')) return
    await api(`${API}/devices/${id}`, { method: 'DELETE' })
    await loadDevices()
  }

  async function portScan(id) {
    await api(`${API}/scan/ports/${id}`, { method: 'POST' })
    await loadDevices()
  }

  return (
    <div>
      <h1>Devices</h1>
      <div className="toolbar">
        <input value={cidr} onChange={e => setCidr(e.target.value)} style={{ width: 180 }} />
        <button onClick={startScan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan Network'}
        </button>
        <button className="secondary" onClick={loadDevices}>Refresh</button>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 13 }}>
          {devices.length} device{devices.length !== 1 ? 's' : ''}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>IP</th>
            <th>Hostname</th>
            <th>MAC</th>
            <th>Vendor</th>
            <th>Type</th>
            <th>VLAN</th>
            <th>Label</th>
            <th>Open Ports</th>
            <th>Last Seen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {devices.map(d => (
            <tr key={d.id}>
              <td>
                <span className={`badge badge-${d.is_online ? 'green' : 'gray'}`}>
                  {d.is_online ? 'online' : 'offline'}
                </span>
              </td>
              <td style={{ fontFamily: 'monospace' }}>{d.ip}</td>
              <td>{d.hostname || '—'}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{d.mac || '—'}</td>
              <td>{d.vendor || '—'}</td>
              <td>
                {editId === d.id ? (
                  <input value={editData.device_type ?? d.device_type ?? ''} style={{ width: 100 }}
                    onChange={e => setEditData(x => ({ ...x, device_type: e.target.value }))} />
                ) : d.device_type || '—'}
              </td>
              <td>
                {editId === d.id ? (
                  <input type="number" value={editData.vlan ?? d.vlan ?? ''} style={{ width: 60 }}
                    onChange={e => setEditData(x => ({ ...x, vlan: e.target.value ? +e.target.value : null }))} />
                ) : d.vlan ?? '—'}
              </td>
              <td>
                {editId === d.id ? (
                  <input value={editData.label ?? d.label ?? ''} style={{ width: 120 }}
                    onChange={e => setEditData(x => ({ ...x, label: e.target.value }))} />
                ) : d.label || '—'}
              </td>
              <td style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {d.open_ports ? JSON.parse(d.open_ports).join(', ') : '—'}
              </td>
              <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {d.last_seen ? new Date(d.last_seen).toLocaleString() : '—'}
              </td>
              <td>
                <div style={{ display: 'flex', gap: 4 }}>
                  {editId === d.id ? (
                    <>
                      <button onClick={() => saveEdit(d.id)}>Save</button>
                      <button className="secondary" onClick={() => setEditId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="secondary" onClick={() => { setEditId(d.id); setEditData({}) }}>Edit</button>
                      <button className="secondary" onClick={() => portScan(d.id)} title="Port scan">⚡</button>
                      <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => deleteDevice(d.id)}>✕</button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

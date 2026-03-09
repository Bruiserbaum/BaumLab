import React, { useEffect, useRef, useState } from 'react'
import { useApi } from '../auth'

const API = '/api'

export default function DevicesPage() {
  const api = useApi()
  const [devices, setDevices] = useState([])
  const [cidr, setCidr] = useState('192.168.1.0/24')
  const [scanning, setScanning] = useState(false)
  const [scanLog, setScanLog] = useState([])
  const [editId, setEditId] = useState(null)
  const [editData, setEditData] = useState({})
  const logRef = useRef(null)
  const pollRef = useRef(null)

  async function loadDevices() {
    const r = await api(`${API}/devices/`)
    setDevices(await r.json())
  }

  useEffect(() => {
    loadDevices()
    api('/api/settings/').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.scan?.default_cidr) setCidr(data.scan.default_cidr)
    }).catch(() => {})
  }, [])

  // Keep log scrolled to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [scanLog])

  async function pollStatus() {
    const r = await api(`${API}/scan/status`)
    if (!r.ok) return
    const data = await r.json()
    setScanLog(data.log || [])
    if (!data.running) {
      clearInterval(pollRef.current)
      setScanning(false)
      await loadDevices()
    }
  }

  async function startScan() {
    setScanning(true)
    setScanLog([])
    await api(`${API}/scan/network?cidr=${encodeURIComponent(cidr)}`, { method: 'POST' })
    pollRef.current = setInterval(pollStatus, 2000)
  }

  useEffect(() => () => clearInterval(pollRef.current), [])

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

      {(scanning || scanLog.length > 0) && (
        <div style={{
          marginTop: 20, background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, overflow: 'hidden',
        }}>
          <div style={{
            padding: '8px 14px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 12, color: 'var(--text-muted)', fontWeight: 600,
          }}>
            {scanning && (
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: 'var(--accent)', animation: 'pulse 1s infinite' }} />
            )}
            SCAN LOG
            {scanning && <span style={{ fontWeight: 400 }}>— scanning {cidr}…</span>}
          </div>
          <div ref={logRef} style={{
            fontFamily: 'monospace', fontSize: 12, padding: '10px 14px',
            maxHeight: 180, overflowY: 'auto', lineHeight: 1.7,
            color: 'var(--text)',
          }}>
            {scanLog.length === 0 && scanning && (
              <span style={{ color: 'var(--text-muted)' }}>Waiting for nmap to start…</span>
            )}
            {scanLog.map((line, i) => (
              <div key={i} style={{
                color: line.includes('ERROR') ? 'var(--red)'
                     : line.includes('New device') ? 'var(--green)'
                     : line.includes('Done') ? 'var(--green)'
                     : 'var(--text)',
              }}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

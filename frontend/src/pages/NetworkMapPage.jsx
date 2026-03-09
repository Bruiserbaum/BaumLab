import React, { useEffect, useState, useCallback } from 'react'
import { useApi } from '../auth'
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
} from 'reactflow'
import 'reactflow/dist/style.css'

const API = '/api'

const TYPE_COLORS = {
  router: '#1f6feb',
  switch: '#388bfd',
  'access-point': '#56d364',
  nas: '#d29922',
  server: '#bc8cff',
  camera: '#f78166',
  pc: '#8b949e',
  default: '#30363d',
}

function deviceColor(type) {
  return TYPE_COLORS[type] || TYPE_COLORS.default
}

function layoutNodes(devices) {
  // Simple grid layout — group by subnet octet
  const groups = {}
  for (const d of devices) {
    const subnet = d.ip.split('.').slice(0, 3).join('.')
    if (!groups[subnet]) groups[subnet] = []
    groups[subnet].push(d)
  }
  const nodes = []
  let gx = 0
  for (const [subnet, devs] of Object.entries(groups)) {
    devs.forEach((d, i) => {
      nodes.push({
        id: String(d.id),
        position: { x: gx * 200, y: i * 100 },
        data: { label: d.label || d.hostname || d.ip, device: d },
        style: {
          background: deviceColor(d.device_type),
          color: '#fff',
          border: `2px solid ${d.is_online ? '#56d364' : '#30363d'}`,
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 12,
          minWidth: 140,
        },
      })
    })
    gx++
  }
  return nodes
}

export default function NetworkMapPage() {
  const api = useApi()
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selected, setSelected] = useState(null)

  async function load() {
    const r = await api(`${API}/devices/`)
    const devices = await r.json()
    setNodes(layoutNodes(devices))
    setEdges([]) // Topology edges would come from UniFi data
  }

  useEffect(() => { load() }, [])

  const onConnect = useCallback(params => setEdges(es => addEdge(params, es)), [])

  function onNodeClick(_, node) {
    setSelected(node.data.device)
  }

  const d = selected

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 48px)', gap: 16 }}>
      <div style={{ flex: 1, background: '#0d1117', borderRadius: 8, border: '1px solid var(--border)' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          fitView
        >
          <Background color="#30363d" />
          <Controls />
          <MiniMap nodeColor={n => n.style?.background || '#30363d'} style={{ background: '#161b22' }} />
        </ReactFlow>
      </div>

      {d && (
        <div className="card" style={{ width: 260, flexShrink: 0, alignSelf: 'flex-start' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <strong>{d.label || d.hostname || d.ip}</strong>
            <button className="secondary" style={{ padding: '2px 8px' }} onClick={() => setSelected(null)}>✕</button>
          </div>
          <Row label="IP" value={d.ip} mono />
          <Row label="MAC" value={d.mac} mono />
          <Row label="Vendor" value={d.vendor} />
          <Row label="Type" value={d.device_type} />
          <Row label="VLAN" value={d.vlan} />
          <Row label="OS" value={d.os_guess} />
          <Row label="Ports" value={d.open_ports ? JSON.parse(d.open_ports).join(', ') : null} mono />
          <Row label="Notes" value={d.notes} />
          <div style={{ marginTop: 8 }}>
            <span className={`badge badge-${d.is_online ? 'green' : 'gray'}`}>
              {d.is_online ? 'online' : 'offline'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, value, mono }) {
  if (!value && value !== 0) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={mono ? { fontFamily: 'monospace' } : {}}>{value}</span>
    </div>
  )
}

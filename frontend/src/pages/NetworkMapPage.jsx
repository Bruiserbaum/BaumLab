import React, { useEffect, useState, useCallback } from 'react'
import { useApi } from '../auth'
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
} from 'reactflow'
import 'reactflow/dist/style.css'

const VLAN_PALETTE = [
  { bg: 'rgba(31,111,235,0.07)',   border: 'rgba(31,111,235,0.35)',   dot: '#388bfd' },
  { bg: 'rgba(210,153,34,0.07)',   border: 'rgba(210,153,34,0.35)',   dot: '#d29922' },
  { bg: 'rgba(188,140,255,0.07)', border: 'rgba(188,140,255,0.35)', dot: '#bc8cff' },
  { bg: 'rgba(247,129,102,0.07)', border: 'rgba(247,129,102,0.35)', dot: '#f78166' },
  { bg: 'rgba(86,211,100,0.07)',  border: 'rgba(86,211,100,0.35)',  dot: '#56d364' },
  { bg: 'rgba(121,192,255,0.07)', border: 'rgba(121,192,255,0.35)', dot: '#79c0ff' },
]

function infraColor(d) {
  const t = (d.type || d.model || '').toLowerCase()
  if (t.includes('ugw') || t.includes('usg') || t.includes('udm')) return '#1f6feb'
  if (t.includes('usw') || t.includes('switch')) return '#388bfd'
  if (t.includes('uap') || t.includes('uap-')) return '#56d364'
  return '#30363d'
}

function isGateway(d) {
  const t = (d.type || d.model || '').toLowerCase()
  return t.includes('ugw') || t.includes('usg') || t.includes('udm') || t.includes('usg')
}

function buildGraph(nmapDevices, uClients, uDevices) {
  const nodes = []
  const edges = []
  const CANVAS_W = 1500
  const NODE_W   = 150
  const NODE_GAP = 20

  // ── Lookup maps ────────────────────────────────────────────────────────────
  const uClientByMac = {}
  const uClientByIp  = {}
  for (const c of uClients) {
    if (c.mac) uClientByMac[c.mac.toLowerCase()] = c
    if (c.ip)  uClientByIp[c.ip] = c
  }
  const infraById = {}  // 'infra-<mac>' → uDevice

  // ── Gateway node ───────────────────────────────────────────────────────────
  const gw   = uDevices.find(isGateway) || (uDevices.length ? uDevices[0] : null)
  const gwId = gw ? `infra-${gw.mac.toLowerCase()}` : null

  if (gw) {
    infraById[gwId] = gw
    nodes.push({
      id: gwId,
      position: { x: CANVAS_W / 2 - 80, y: 20 },
      data: { label: gw.name || 'Gateway', device: gw, isInfra: true },
      style: {
        background: '#1f6feb', color: '#fff',
        border: '2px solid #79c0ff', borderRadius: 8,
        padding: '8px 14px', fontSize: 12, fontWeight: 700, minWidth: 160,
      },
    })
  }

  // ── Infrastructure nodes (switches, APs) ───────────────────────────────────
  const infraDevices = uDevices.filter(d => d !== gw)
  const infraY = 170
  infraDevices.forEach((d, i) => {
    const id = `infra-${d.mac.toLowerCase()}`
    infraById[id] = d
    const color = infraColor(d)
    const x = infraDevices.length === 1
      ? CANVAS_W / 2 - 80
      : 80 + (CANVAS_W - 200) / Math.max(infraDevices.length - 1, 1) * i
    nodes.push({
      id,
      position: { x, y: infraY },
      data: { label: d.name || d.model || d.mac, device: d, isInfra: true },
      style: {
        background: color, color: '#fff',
        border: `2px solid ${color}`, borderRadius: 8,
        padding: '6px 10px', fontSize: 11, minWidth: 130,
      },
    })
    if (gwId) {
      edges.push({
        id: `e-gw-${id}`, source: gwId, target: id,
        style: { stroke: '#30363d', strokeWidth: 2 },
      })
    }
  })

  // ── Enrich nmap devices with UniFi data + group by VLAN ───────────────────
  const vlanMap = {}  // vlanKey → devices[]
  const hasUniFi = uClients.length > 0 || uDevices.length > 0

  for (const d of nmapDevices) {
    const uc = uClientByMac[d.mac?.toLowerCase()] || uClientByIp[d.ip] || null
    let vlanKey
    if (uc) {
      vlanKey = uc.vlan != null
        ? (uc.network ? `${uc.network} — VLAN ${uc.vlan}` : `VLAN ${uc.vlan}`)
        : (uc.network || d.ip.split('.').slice(0, 3).join('.') + '.0/24')
    } else {
      vlanKey = d.ip.split('.').slice(0, 3).join('.') + '.0/24'
    }
    if (!vlanMap[vlanKey]) vlanMap[vlanKey] = []
    vlanMap[vlanKey].push({ ...d, _uc: uc })
  }

  // ── Lay out VLAN groups ────────────────────────────────────────────────────
  const GROUP_H      = 140
  const GROUP_Y_START = infraDevices.length || gw ? 330 : 40

  Object.entries(vlanMap).forEach(([vlanKey, devs], gi) => {
    const palette = VLAN_PALETTE[gi % VLAN_PALETTE.length]
    const groupW  = Math.max(CANVAS_W, devs.length * (NODE_W + NODE_GAP) + NODE_GAP * 2 + 20)
    const groupId = `vlan-${gi}`
    const groupY  = GROUP_Y_START + gi * (GROUP_H + 20)

    nodes.push({
      id: groupId,
      type: 'group',
      position: { x: 0, y: groupY },
      style: {
        width: groupW, height: GROUP_H,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
      },
      data: { label: vlanKey },
    })

    devs.forEach((d, i) => {
      const nodeId  = String(d.id)
      const uc      = d._uc
      const isWired = uc?.is_wired ?? true
      const label   = d.label || d.hostname || d.ip

      nodes.push({
        id: nodeId,
        parentNode: groupId,
        extent: 'parent',
        position: { x: NODE_GAP + i * (NODE_W + NODE_GAP), y: 36 },
        data: { label, device: d, uClient: uc },
        style: {
          background: '#1c2129',
          color: '#e6edf3',
          border: `2px solid ${palette.dot}`,
          borderRadius: 8,
          padding: '5px 8px',
          fontSize: 11,
          width: NODE_W,
        },
      })

      // Connect client → its AP / switch → gateway
      const apId = uc?.ap_mac ? `infra-${uc.ap_mac.toLowerCase()}` : null
      const swId = uc?.sw_mac ? `infra-${uc.sw_mac.toLowerCase()}` : null
      const edgeTarget = (apId && infraById[apId])
        ? apId
        : (swId && infraById[swId])
        ? swId
        : gwId

      if (edgeTarget) {
        edges.push({
          id: `e-${nodeId}`,
          source: edgeTarget,
          target: nodeId,
          style: { stroke: palette.dot, strokeWidth: 1, opacity: 0.4 },
        })
      }
    })
  })

  return { nodes, edges }
}

export default function NetworkMapPage() {
  const api = useApi()
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selected, setSelected] = useState(null)
  const [hasUniFi, setHasUniFi] = useState(false)

  async function load() {
    const devR    = await api('/api/devices/')
    const devices = await devR.json()

    let uClients = [], uDevices = []
    try {
      const [ucR, udR] = await Promise.all([
        api('/api/unifi/clients'),
        api('/api/unifi/devices'),
      ])
      if (ucR.ok) uClients = await ucR.json()
      if (udR.ok) uDevices = await udR.json()
    } catch { /* UniFi not configured */ }

    setHasUniFi(uClients.length > 0 || uDevices.length > 0)
    const { nodes: n, edges: e } = buildGraph(devices, uClients, uDevices)
    setNodes(n)
    setEdges(e)
  }

  useEffect(() => { load() }, [])

  const onConnect = useCallback(params => setEdges(es => addEdge(params, es)), [])

  function onNodeClick(_, node) {
    if (node.type === 'group' || (!node.data?.device)) return
    setSelected(node.data)
  }

  const sel = selected
  const d   = sel?.device
  const uc  = sel?.uClient

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 48px)', gap: 16 }}>
      <div style={{ flex: 1, background: '#0d1117', borderRadius: 8, border: '1px solid var(--border)', position: 'relative' }}>
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

        {/* Legend */}
        <div style={{
          position: 'absolute', bottom: 60, left: 10,
          background: 'rgba(13,17,23,0.88)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)',
          display: 'flex', flexDirection: 'column', gap: 5, pointerEvents: 'none',
        }}>
          <Dot color="#1f6feb" label="Gateway" />
          <Dot color="#388bfd" label="Switch" />
          <Dot color="#56d364" label="Access Point" />
          <Dot color="#8b949e" label="Client" />
          {!hasUniFi && (
            <div style={{ marginTop: 4, fontSize: 10, color: '#e3b341' }}>
              UniFi not connected — grouped by subnet
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {d && (
        <div className="card" style={{ width: 260, flexShrink: 0, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 80px)', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <strong style={{ fontSize: 13 }}>{d.label || d.hostname || d.ip || d.name || d.mac}</strong>
            <button className="secondary" style={{ padding: '2px 8px' }} onClick={() => setSelected(null)}>✕</button>
          </div>

          {!sel.isInfra && (
            <>
              <Row label="IP"     value={d.ip} mono />
              <Row label="MAC"    value={d.mac} mono />
              <Row label="Vendor" value={d.vendor} />
              <Row label="Type"   value={d.device_type} />
              <Row label="OS"     value={d.os_guess} />
              <Row label="Ports"  value={d.open_ports ? JSON.parse(d.open_ports).join(', ') : null} mono />
              <Row label="Label"  value={d.label} />
              <div style={{ marginTop: 8 }}>
                <span className={`badge badge-${d.is_online ? 'green' : 'gray'}`}>
                  {d.is_online ? 'online' : 'offline'}
                </span>
              </div>
            </>
          )}

          {sel.isInfra && (
            <>
              <Row label="IP"      value={d.ip} mono />
              <Row label="MAC"     value={d.mac} mono />
              <Row label="Model"   value={d.model} />
              <Row label="Version" value={d.version} />
              <Row label="Clients" value={d.num_sta} />
              <Row label="Uptime"  value={d.uptime != null ? `${Math.floor(d.uptime / 3600)}h ${Math.floor((d.uptime % 3600) / 60)}m` : null} />
            </>
          )}

          {uc && (
            <>
              <div style={{
                margin: '10px 0 8px', borderTop: '1px solid var(--border)', paddingTop: 10,
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px',
                color: 'var(--text-muted)',
              }}>
                UniFi
              </div>
              <Row label="Network" value={uc.network} />
              <Row label="VLAN"    value={uc.vlan} />
              <Row label="Link"    value={uc.is_wired ? 'Wired' : 'Wireless'} />
              {!uc.is_wired && <Row label="SSID"   value={uc.essid} />}
              {!uc.is_wired && <Row label="Signal" value={uc.signal != null ? `${uc.signal} dBm` : null} />}
              {uc.is_wired  && <Row label="Port"   value={uc.sw_port != null ? `Port ${uc.sw_port}` : null} />}
              <Row label="Uptime"  value={uc.uptime != null ? `${Math.floor(uc.uptime / 3600)}h ${Math.floor((uc.uptime % 3600) / 60)}m` : null} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, mono }) {
  if (value == null || value === '') return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={mono ? { fontFamily: 'monospace' } : {}}>{String(value)}</span>
    </div>
  )
}

function Dot({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </div>
  )
}

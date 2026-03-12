/**
 * Vulnerability Scan — powered by Greenbone Community Edition / OpenVAS
 * https://www.greenbone.net/  |  https://github.com/greenbone
 * OpenVAS is open-source software licensed under GPLv2.
 */
import React, { useEffect, useState, useCallback } from 'react'
import { useApi } from '../auth'

const API = '/api/vuln-scan'
const POLL_MS = 8000

// Severity → display config
const SEVERITY = [
  { label: 'Critical', min: 9.0,  color: '#f85149', bg: 'rgba(248,81,73,0.12)'  },
  { label: 'High',     min: 7.0,  color: '#f78166', bg: 'rgba(247,129,102,0.12)' },
  { label: 'Medium',   min: 4.0,  color: '#e3b341', bg: 'rgba(227,179,65,0.12)'  },
  { label: 'Low',      min: 0.1,  color: '#79c0ff', bg: 'rgba(121,192,255,0.12)' },
  { label: 'Log',      min: -999, color: '#8b949e', bg: 'rgba(139,148,158,0.08)' },
]

function severityCfg(score) {
  return SEVERITY.find(s => score >= s.min) || SEVERITY[SEVERITY.length - 1]
}

function SeverityBadge({ score }) {
  const cfg = severityCfg(score)
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}33`,
      padding: '2px 7px', borderRadius: 4, flexShrink: 0,
    }}>
      {cfg.label} {score > 0 ? score.toFixed(1) : ''}
    </span>
  )
}

function StatusBadge({ status, progress }) {
  const color = status === 'Done' ? '#3fb950'
    : status === 'Running'       ? '#388bfd'
    : status === 'Stopped'       ? '#e3b341'
    : '#8b949e'
  return (
    <span style={{ fontSize: 12, color, fontWeight: 600 }}>
      {status === 'Running' && progress >= 0 ? `Running ${progress}%` : status}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VulnScanPage() {
  const api = useApi()
  const [health, setHealth]     = useState(null)
  const [configs, setConfigs]   = useState([])
  const [tasks, setTasks]       = useState([])
  const [target, setTarget]     = useState('')
  const [configId, setConfigId] = useState('')
  const [scanName, setScanName] = useState('')
  const [starting, setStarting] = useState(false)
  const [startErr, setStartErr] = useState('')
  const [expanded, setExpanded] = useState(null)   // task id
  const [results, setResults]   = useState({})     // task_id → findings[]
  const [loadingRes, setLoadingRes] = useState(null)

  const load = useCallback(async () => {
    const [hr, tr] = await Promise.all([
      api(`${API}/health`),
      api(`${API}/tasks`),
    ])
    if (hr.ok) setHealth(await hr.json())
    if (tr.ok) setTasks(await tr.json())
  }, [api])

  const loadConfigs = useCallback(async () => {
    const r = await api(`${API}/configs`)
    if (r.ok) {
      const list = await r.json()
      setConfigs(list)
      if (list.length && !configId) setConfigId(list[0].id)
    }
  }, [api, configId])

  useEffect(() => {
    load()
    loadConfigs()
  }, [])

  // Poll while any task is running
  useEffect(() => {
    const running = tasks.some(t => t.status === 'Running' || t.status === 'Requested')
    if (!running) return
    const t = setInterval(() => load(), POLL_MS)
    return () => clearInterval(t)
  }, [tasks])

  async function startScan(e) {
    e.preventDefault()
    setStarting(true); setStartErr('')
    const r = await api(`${API}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: target.trim(), scan_config_id: configId, name: scanName || null }),
    })
    if (r.ok) {
      setTarget(''); setScanName('')
      await load()
    } else {
      const d = await r.json().catch(() => ({}))
      setStartErr(d.detail || 'Failed to start scan')
    }
    setStarting(false)
  }

  async function viewResults(taskId) {
    if (expanded === taskId) { setExpanded(null); return }
    setExpanded(taskId)
    if (results[taskId]) return
    setLoadingRes(taskId)
    const r = await api(`${API}/tasks/${taskId}/results`)
    if (r.ok) { const data = await r.json(); setResults(prev => ({ ...prev, [taskId]: data })) }
    setLoadingRes(null)
  }

  async function deleteTask(taskId, e) {
    e.stopPropagation()
    if (!confirm('Delete this scan and all its results?')) return
    await api(`${API}/tasks/${taskId}`, { method: 'DELETE' })
    setTasks(prev => prev.filter(t => t.id !== taskId))
    if (expanded === taskId) setExpanded(null)
  }

  // Count by severity for a task
  function counts(task) {
    const r = results[task.id]
    if (!r) return task.counts || {}
    const c = { critical: 0, high: 0, medium: 0, low: 0, log: 0 }
    for (const f of r) {
      if (f.severity >= 9)        c.critical++
      else if (f.severity >= 7)   c.high++
      else if (f.severity >= 4)   c.medium++
      else if (f.severity >= 0.1) c.low++
      else                        c.log++
    }
    return c
  }

  return (
    <div>
      <h1>Vulnerability Scan</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: -8, marginBottom: 20, fontSize: 14 }}>
        Full CVE/NVT vulnerability scanning powered by{' '}
        <a href="https://www.greenbone.net/" target="_blank" rel="noreferrer"
          style={{ color: 'var(--accent)' }}>
          Greenbone Community Edition / OpenVAS
        </a>.
      </p>

      {/* ── Health banner ── */}
      {health && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', marginBottom: 20,
          background: health.connected ? 'rgba(35,134,54,0.1)' : 'rgba(218,54,51,0.1)',
          border: `1px solid ${health.connected ? '#238636' : '#da3633'}`,
          borderRadius: 6, fontSize: 13,
        }}>
          <div style={{
            width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
            background: health.connected ? '#3fb950' : '#f85149',
          }} />
          {health.connected
            ? <span>OpenVAS connected — GVM <strong>{health.version}</strong></span>
            : <span style={{ color: '#f85149' }}>OpenVAS not reachable — {health.error}. Configure in <strong>Settings → OpenVAS</strong>.</span>
          }
          <button className="secondary" style={{ marginLeft: 'auto' }} onClick={load}>Refresh</button>
        </div>
      )}

      {/* ── New scan form ── */}
      {health?.connected && (
        <form className="card" onSubmit={startScan}
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 24 }}>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Target IP or Hostname</div>
            <input required value={target} onChange={e => setTarget(e.target.value)}
              placeholder="192.168.1.1" style={{ width: 180 }} />
          </label>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Scan Configuration</div>
            <select value={configId} onChange={e => setConfigId(e.target.value)} style={{ minWidth: 220 }}>
              {configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Name (optional)</div>
            <input value={scanName} onChange={e => setScanName(e.target.value)}
              placeholder="e.g. Weekly scan" style={{ width: 160 }} />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button type="submit" disabled={starting || !target.trim() || !configId}>
              {starting ? '⏳ Starting…' : '▶ Start Scan'}
            </button>
            {startErr && <span style={{ fontSize: 11, color: 'var(--red)' }}>{startErr}</span>}
          </div>
        </form>
      )}

      {/* ── Tasks list ── */}
      {tasks.length === 0 && health?.connected && (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>No scans yet. Start one above.</div>
      )}

      {tasks.map(task => {
        const c    = counts(task)
        const done = task.status === 'Done'
        const open = expanded === task.id
        const res  = results[task.id] || []

        return (
          <div key={task.id} style={{ marginBottom: 12 }}>
            {/* Task row */}
            <div
              onClick={() => done && viewResults(task.id)}
              style={{
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: open ? '6px 6px 0 0' : 6,
                padding: '12px 16px',
                cursor: done ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{task.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{task.target}</div>
              </div>

              <StatusBadge status={task.status} progress={task.progress} />

              {/* Progress bar */}
              {task.status === 'Running' && task.progress >= 0 && (
                <div style={{ width: 120, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${task.progress}%`, background: '#388bfd', transition: 'width 0.5s' }} />
                </div>
              )}

              {/* Severity counts */}
              {done && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {c.critical > 0 && <Pill n={c.critical} color="#f85149" label="C" />}
                  {c.high     > 0 && <Pill n={c.high}     color="#f78166" label="H" />}
                  {c.medium   > 0 && <Pill n={c.medium}   color="#e3b341" label="M" />}
                  {c.low      > 0 && <Pill n={c.low}      color="#79c0ff" label="L" />}
                  {c.log      > 0 && <Pill n={c.log}      color="#8b949e" label="I" />}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {done && (
                  <span style={{ fontSize: 12, color: 'var(--accent)' }}>
                    {open ? '▲ Hide results' : '▼ View results'}
                  </span>
                )}
                <button className="secondary" style={{ color: 'var(--red)', padding: '3px 8px', fontSize: 11 }}
                  onClick={e => deleteTask(task.id, e)}>
                  ✕
                </button>
              </div>
            </div>

            {/* Results panel */}
            {open && (
              <div style={{
                border: '1px solid var(--border)', borderTop: 'none',
                borderRadius: '0 0 6px 6px', background: '#0d1117',
              }}>
                {loadingRes === task.id && (
                  <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Loading results…</div>
                )}
                {loadingRes !== task.id && res.length === 0 && (
                  <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>No findings — clean bill of health.</div>
                )}
                {loadingRes !== task.id && res.length > 0 && (
                  <ResultsTable findings={res} />
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Footer credit */}
      <div style={{ marginTop: 32, fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        Vulnerability scanning powered by{' '}
        <a href="https://www.greenbone.net/" target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>
          Greenbone Community Edition
        </a>
        {' '}and{' '}
        <a href="https://www.openvas.org/" target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>
          OpenVAS
        </a>
        {' '}— open-source vulnerability scanning licensed under GPLv2.
      </div>
    </div>
  )
}

// ── Results table ─────────────────────────────────────────────────────────────

function ResultsTable({ findings }) {
  const [expanded, setExpanded] = useState(null)

  return (
    <div>
      {/* Summary bar */}
      {(() => {
        const c = { critical: 0, high: 0, medium: 0, low: 0, log: 0 }
        for (const f of findings) {
          if (f.severity >= 9) c.critical++
          else if (f.severity >= 7) c.high++
          else if (f.severity >= 4) c.medium++
          else if (f.severity >= 0.1) c.low++
          else c.log++
        }
        return (
          <div style={{
            display: 'flex', gap: 20, padding: '12px 16px',
            borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
          }}>
            {[['Critical', c.critical, '#f85149'], ['High', c.high, '#f78166'],
              ['Medium', c.medium, '#e3b341'], ['Low', c.low, '#79c0ff'],
              ['Info/Log', c.log, '#8b949e']].map(([label, n, color]) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: n > 0 ? color : 'var(--border)' }}>{n}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
              </div>
            ))}
            <div style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              {findings.length} total findings
            </div>
          </div>
        )
      })()}

      {/* Findings list */}
      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
        {findings.map(f => {
          const cfg  = severityCfg(f.severity)
          const open = expanded === f.id
          return (
            <div key={f.id}
              style={{
                borderBottom: '1px solid var(--border)',
                borderLeft: `3px solid ${cfg.color}`,
              }}>
              <div
                onClick={() => setExpanded(open ? null : f.id)}
                style={{
                  padding: '10px 14px', cursor: 'pointer',
                  display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                }}
              >
                <SeverityBadge score={f.severity} />
                <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>{f.name}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>
                  {f.host}{f.hostname ? ` (${f.hostname})` : ''}{f.port ? ` : ${f.port}` : ''}
                </span>
                {f.cves.length > 0 && (
                  <span style={{ fontSize: 10, color: '#79c0ff', fontFamily: 'monospace' }}>
                    {f.cves.slice(0, 2).join(', ')}{f.cves.length > 2 ? ` +${f.cves.length - 2}` : ''}
                  </span>
                )}
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
              </div>

              {open && (
                <div style={{ padding: '0 14px 14px', fontSize: 12 }}>
                  {f.description && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginBottom: 4 }}>Description</div>
                      <pre style={{ margin: 0, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 4, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
                        {f.description}
                      </pre>
                    </div>
                  )}
                  {f.solution && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#3fb950', marginBottom: 4 }}>Solution</div>
                      <pre style={{ margin: 0, padding: '8px 10px', background: 'rgba(35,134,54,0.06)', border: '1px solid rgba(35,134,54,0.2)', borderRadius: 4, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
                        {f.solution}
                      </pre>
                    </div>
                  )}
                  {f.cves.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, fontFamily: 'monospace', color: '#79c0ff' }}>
                      CVE: {f.cves.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Pill({ n, color, label }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color,
      background: `${color}20`, border: `1px solid ${color}40`,
      padding: '1px 7px', borderRadius: 4,
    }}>
      {n} {label}
    </span>
  )
}

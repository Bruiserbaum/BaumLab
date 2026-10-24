import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi, useAuth } from '../auth'
import DiscoverPanel from './DiscoverPanel'

const API = '/api'
const PROTOCOLS = ['http', 'https', 'tcp', 'udp']
const PLATFORMS = ['docker', 'vm', 'lxc', 'bare-metal', 'appliance']
const STATUSES = ['active', 'planned', 'decommissioned']
const REFRESH_MS = 15_000
const CATEGORY_SUGGESTIONS = [
  'Media', 'Home Automation', 'Infrastructure', 'Networking', 'Monitoring',
  'Security', 'Storage', 'Productivity', 'Development', 'Gaming',
]

const blankExtras = { monitor: true, vault: false, vault_username: '', vault_secret: '', backup: false }

const blank = {
  name: '', status: 'active', category: '', host: '', platform: '', ip: '', port: '', protocol: 'http',
  vlan: '', url: '', proxied: false, sso: false, external: false, monitor_id: '', credential_ref: '', notes: '',
}

// Each group-by option maps a service to the label of the group it belongs in
const GROUPINGS = {
  category: { label: 'Category', key: s => s.category || 'Uncategorized' },
  host:     { label: 'Host',     key: s => s.host || 'Unknown host' },
  vlan:     { label: 'VLAN',     key: s => s.vlan != null ? `VLAN ${s.vlan}` : 'No VLAN' },
  platform: { label: 'Platform', key: s => s.platform || 'Unspecified' },
  access:   { label: 'Access',   key: s =>
    s.proxied && s.sso ? 'Proxy + SSO'
    : s.proxied        ? 'Proxy, no SSO'
    : s.sso            ? 'SSO, direct'
    :                    'Direct access' },
  status:   { label: 'Status',   key: s => s.status },
  none:     { label: 'None',     key: () => 'All services' },
}

function ago(isoString) {
  if (!isoString) return null
  const secs = Math.floor((Date.now() - new Date(isoString + 'Z').getTime()) / 1000)
  if (secs < 60)  return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60)  return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 48 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

function directUrl(s) {
  if (!s.ip) return null
  const hostPort = s.port ? `${s.ip}:${s.port}` : s.ip
  return s.protocol === 'http' || s.protocol === 'https' ? `${s.protocol}://${hostPort}` : null
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** Open a print-friendly inventory in a new window; the browser's print dialog can save it as PDF. */
const BACKUP_LABELS = {
  ok: ['green', 'OK'], stale: ['yellow', 'Stale'], failed: ['red', 'Failed'],
  never: ['red', 'Never ran'], disabled: ['gray', 'Disabled'], none: ['red', 'None'],
}

function printReport(groups, { groupLabel, search, total, backups = {} }) {
  const yes = b => (b ? '✓' : '')
  const backupText = s => s.status === 'decommissioned' ? '' : BACKUP_LABELS[backups[s.id]?.status ?? 'none'][1]
  const sections = groups.map(([group, items]) => `
    <h2>${esc(group)} <span class="count">(${items.length})</span></h2>
    <table>
      <thead><tr>
        <th class="chk"></th><th>Name</th><th>Category</th><th>Host</th><th>IP : Port</th>
        <th>VLAN</th><th>Access URL</th><th>Proxy</th><th>SSO</th><th>Public</th><th>Backup</th><th>Notes</th>
      </tr></thead>
      <tbody>${items.map(s => `
        <tr class="${s.status === 'decommissioned' ? 'retired' : ''}">
          <td class="chk"><span class="box"></span></td>
          <td><b>${esc(s.name)}</b>${s.status !== 'active' ? ` <span class="muted">(${esc(s.status)})</span>` : ''}</td>
          <td>${esc(s.category)}</td>
          <td>${esc(s.host)}${s.platform ? ` <span class="muted">(${esc(s.platform)})</span>` : ''}</td>
          <td class="mono">${esc(s.ip)}${s.port ? `:${esc(s.port)}` : ''} <span class="muted">${esc(s.protocol)}</span></td>
          <td>${esc(s.vlan)}</td>
          <td class="mono">${esc(s.url)}</td>
          <td class="c">${yes(s.proxied)}</td>
          <td class="c">${yes(s.sso)}</td>
          <td class="c ${s.external && !s.sso ? 'warn' : ''}">${yes(s.external)}</td>
          <td class="${['OK', ''].includes(backupText(s)) ? '' : 'warn'}">${esc(backupText(s))}</td>
          <td>${esc(s.notes)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`).join('')

  const shown = groups.reduce((n, [, items]) => n + items.length, 0)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>BaumLab Service Inventory</title>
    <style>
      @page { size: landscape; margin: 12mm; }
      body { font: 11px/1.4 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 0; }
      h1 { font-size: 18px; margin: 0 0 2px; }
      .meta { color: #555; margin-bottom: 14px; }
      h2 { font-size: 13px; margin: 16px 0 6px; border-bottom: 2px solid #333; padding-bottom: 2px; }
      .count { color: #666; font-weight: normal; }
      table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
      tr { page-break-inside: avoid; }
      thead { display: table-header-group; }
      th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
      th { background: #eee; font-weight: 600; }
      .mono { font-family: Consolas, monospace; word-break: break-all; }
      .muted { color: #666; }
      .c { text-align: center; }
      .warn { background: #fdd; font-weight: 700; }
      .chk { width: 16px; text-align: center; }
      .box { display: inline-block; width: 10px; height: 10px; border: 1px solid #333; }
      .retired td { color: #888; }
    </style></head><body>
    <h1>BaumLab Service Inventory</h1>
    <div class="meta">
      Generated ${esc(new Date().toLocaleString())} · ${shown} of ${total} services · grouped by ${esc(groupLabel)}
      ${search ? ` · filter: “${esc(search)}”` : ''}
    </div>
    ${sections || '<p>No services.</p>'}
    </body></html>`

  const win = window.open('', '_blank')
  if (!win) { alert('Pop-up blocked — allow pop-ups for BaumLab to export.'); return }
  win.document.write(html)
  win.document.close()
  win.focus()
  win.print()
}

function Field({ label, children }) {
  return (
    <label>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  )
}

function Check({ label, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export default function ServicesPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [vaultCounts, setVaultCounts] = useState({})   // service id → number of vault entries
  const [services, setServices]   = useState([])
  const [devices, setDevices]     = useState([])
  const [monitors, setMonitors]   = useState([])
  const [statusMap, setStatusMap] = useState({})   // monitor id → status from /api/status/public
  const [groupBy, setGroupBy]     = useState(() => localStorage.getItem('bl_services_group') || 'category')
  const [search, setSearch]       = useState('')
  const [form, setForm]           = useState(blank)
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState(null)
  const [showRetired, setShowRetired] = useState(false)
  const [gitStatus, setGitStatus] = useState(null)
  const [syncing, setSyncing]     = useState(false)
  const [syncError, setSyncError] = useState('')
  const [showDiscover, setShowDiscover] = useState(false)
  const [extras, setExtras]       = useState(blankExtras)   // pieces created along with a new service
  const [notice, setNotice]       = useState(null)
  const [backups, setBackups]     = useState({})     // service id → { status, sources } from /api/backups/coverage
  const navigate = useNavigate()

  async function loadServices() {
    const r = await api(`${API}/services/`)
    if (r.ok) setServices(await r.json())
    loadGitStatus()
  }

  async function loadGitStatus() {
    const r = await api(`${API}/git-sync/status`)
    if (r.ok) setGitStatus(await r.json())
  }

  async function syncNow() {
    setSyncing(true); setSyncError('')
    const r = await api(`${API}/git-sync/sync`, { method: 'POST' })
    if (!r.ok) setSyncError((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
    setSyncing(false)
    loadGitStatus()
  }

  function loadDevices() {
    api(`${API}/devices/`).then(r => r.ok ? r.json() : []).then(setDevices).catch(() => {})
  }

  async function load() {
    await loadServices()
    // Supporting data is best-effort — the page still works without it
    loadDevices()
    api(`${API}/monitors/`).then(r => r.ok ? r.json() : []).then(setMonitors).catch(() => {})
    if (isAdmin) {
      api(`${API}/vault/`).then(r => r.ok ? r.json() : []).then(entries => {
        const counts = {}
        for (const e of entries) if (e.service_id != null) counts[e.service_id] = (counts[e.service_id] ?? 0) + 1
        setVaultCounts(counts)
      }).catch(() => {})
    }
    api(`${API}/backups/coverage`).then(r => r.ok ? r.json() : {}).then(setBackups).catch(() => {})
    fetch(`${API}/status/public`).then(r => r.json()).then(data => {
      const map = {}
      for (const m of data.monitors ?? []) map[m.id] = m
      setStatusMap(map)
    }).catch(() => {})
  }

  useEffect(() => {
    load()
    // Keeps the pending/last-synced indicator current while auto-sync runs in the background
    const interval = setInterval(loadGitStatus, REFRESH_MS)
    return () => clearInterval(interval)
  }, [])

  function changeGroup(value) {
    setGroupBy(value)
    localStorage.setItem('bl_services_group', value)
  }

  function openAdd() {
    setEditId(null)
    setForm(blank)
    setExtras(blankExtras)
    setShowForm(true)
    setShowDiscover(false)
  }

  function openEdit(s) {
    setEditId(s.id)
    setForm(Object.fromEntries(Object.keys(blank).map(k => [k, s[k] ?? blank[k]])))
    setShowForm(true)
  }

  function cancelForm() {
    setShowForm(false)
    setEditId(null)
    setForm(blank)
  }

  // When an IP matches a discovered device, pre-fill VLAN from it if the user hasn't set one
  function setIp(ip) {
    setForm(x => {
      const dev = devices.find(d => d.ip === ip)
      return { ...x, ip, vlan: x.vlan === '' && dev?.vlan != null ? dev.vlan : x.vlan }
    })
  }

  async function submit(e) {
    e.preventDefault()
    const body = {
      ...form,
      port:       form.port !== '' ? +form.port : null,
      vlan:       form.vlan !== '' ? +form.vlan : null,
      monitor_id: form.monitor_id !== '' ? +form.monitor_id : null,
    }
    for (const k of ['category', 'host', 'platform', 'ip', 'url', 'credential_ref', 'notes']) {
      body[k] = body[k]?.trim() || null
    }
    const isNew = editId == null
    if (isNew) body.create_monitor = extras.monitor && !body.monitor_id && !!body.ip
    const r = await api(isNew ? `${API}/services/` : `${API}/services/${editId}`, {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      setNotice({ ok: false, text: (await r.json().catch(() => ({}))).detail || `Save failed (HTTP ${r.status})` })
      return
    }
    const saved = await r.json()
    const done = [isNew ? `Added ${saved.name}` : `Saved ${saved.name}`]
    if (body.create_monitor && saved.monitor_id) done.push('monitor created')

    // The vault has its own admin + safety checks, so it's a separate call; the service is kept either way
    if (isNew && extras.vault && extras.vault_secret) {
      const v = await api(`${API}/vault/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: saved.id, title: `${saved.name} login`, username: extras.vault_username.trim() || null,
          secret: extras.vault_secret, url: saved.url || directUrl(saved),
        }),
      })
      if (v.ok) done.push('credentials saved to vault')
      else done.push(`vault entry failed: ${(await v.json().catch(() => ({}))).detail || `HTTP ${v.status}`}`)
    }
    setNotice({ ok: !done.some(d => d.includes('failed')), text: done.join(' · ') })
    const wantsBackup = isNew && isAdmin && extras.backup
    cancelForm()
    if (wantsBackup) { navigate(`/backups?tab=jobs&service=${saved.id}`); return }
    await load()
  }

  async function remove(id) {
    if (!confirm('Delete this service permanently?\n\nTip: set its status to "decommissioned" instead to keep it in the inventory history.')) return
    await api(`${API}/services/${id}`, { method: 'DELETE' })
    await loadServices()
  }

  const categories = useMemo(
    () => [...new Set([...CATEGORY_SUGGESTIONS, ...services.map(s => s.category).filter(Boolean)])].sort(),
    [services],
  )
  const hosts = useMemo(
    () => [...new Set(services.map(s => s.host).filter(Boolean))].sort(),
    [services],
  )

  const live    = useMemo(() => services.filter(s => s.status !== 'decommissioned'), [services])
  const retired = services.length - live.length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = showRetired ? services : live
    if (!q) return pool
    return pool.filter(s =>
      [s.name, s.status, s.category, s.host, s.platform, s.ip, s.url, s.credential_ref, s.notes, s.port, s.vlan]
        .some(v => v != null && String(v).toLowerCase().includes(q)))
  }, [services, live, search, showRetired])

  const groups = useMemo(() => {
    const keyFn = (GROUPINGS[groupBy] ?? GROUPINGS.category).key
    const map = new Map()
    for (const s of filtered) {
      const k = keyFn(s)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(s)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  }, [filtered, groupBy])

  const exposedNoSso = live.filter(s => s.external && !s.sso).length

  return (
    <div>
      <h1>Services</h1>

      {/* ── Summary ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          ['Services', live.length],
          ['Behind proxy', live.filter(s => s.proxied).length],
          ['Behind SSO', live.filter(s => s.sso).length],
          ['Internet-facing', live.filter(s => s.external).length],
          ['Without backup', live.filter(s => !backups[s.id] || backups[s.id].status === 'none').length],
          ['Hosts', new Set(live.map(s => s.host).filter(Boolean)).size],
          ...(retired ? [['Decommissioned', retired]] : []),
        ].map(([label, n]) => (
          <div key={label} className="card" style={{ marginBottom: 0, padding: '10px 16px', minWidth: 110 }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{n}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
          </div>
        ))}
        {exposedNoSso > 0 && (
          <div className="card" style={{ marginBottom: 0, padding: '10px 16px', borderColor: 'var(--red)' }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--red)' }}>{exposedNoSso}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Internet-facing without SSO</div>
          </div>
        )}
      </div>

      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <button onClick={showForm && editId == null ? cancelForm : openAdd}>
          {showForm && editId == null ? 'Cancel' : '+ Add Service'}
        </button>
        <button className="secondary" onClick={() => { setShowDiscover(v => !v); setShowForm(false) }}>
          🔍 Discover
        </button>
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 8 }}>Group by</span>
        <select value={groupBy} onChange={e => changeGroup(e.target.value)}>
          {Object.entries(GROUPINGS).map(([k, g]) => <option key={k} value={k}>{g.label}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />
          Show decommissioned{retired ? ` (${retired})` : ''}
        </label>
        <button className="secondary" onClick={load}>Refresh</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {gitStatus?.configured && (
            <>
              <span style={{ fontSize: 12, color: syncError || gitStatus.last_error ? 'var(--red)' : 'var(--text-muted)' }}
                title={syncError || gitStatus.last_error || ''}>
                {syncError || gitStatus.last_error
                  ? '✗ Git sync failed'
                  : gitStatus.pending > 0
                    ? `${gitStatus.pending} change${gitStatus.pending !== 1 ? 's' : ''} pending`
                    : gitStatus.last_sync_at
                      ? <>Synced {ago(gitStatus.last_sync_at)}{gitStatus.last_commit_url && (
                          <> · <a href={gitStatus.last_commit_url} target="_blank" rel="noreferrer"
                            style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>
                            {gitStatus.last_commit_sha?.slice(0, 7)}
                          </a></>)}</>
                      : 'Not synced yet'}
              </span>
              <button className="secondary" onClick={syncNow} disabled={syncing}>
                {syncing ? 'Syncing…' : '⟳ Sync to Git'}
              </button>
            </>
          )}
          <button className="secondary" disabled={filtered.length === 0}
            onClick={() => printReport(groups, {
              groupLabel: (GROUPINGS[groupBy] ?? GROUPINGS.category).label,
              search: search.trim(),
              total: services.length,
              backups,
            })}>
            ⎙ Export PDF
          </button>
        </div>
      </div>

      {notice && (
        <div style={{ fontSize: 12, marginBottom: 12, padding: '8px 12px', borderRadius: 6,
          display: 'flex', justifyContent: 'space-between',
          color: notice.ok ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${notice.ok ? 'var(--green)' : 'var(--red)'}`,
          background: notice.ok ? '#1a2e1a' : '#2e1a1a' }}>
          {notice.ok ? '✓' : '✗'} {notice.text}
          <span style={{ cursor: 'pointer' }} onClick={() => setNotice(null)}>✕</span>
        </div>
      )}

      {showDiscover && (
        <DiscoverPanel api={api} devices={devices} categories={categories}
          onClose={() => setShowDiscover(false)}
          onDevicesChanged={loadDevices}
          onAdded={n => { setShowDiscover(false); setNotice({ ok: true, text: `Added ${n} service${n !== 1 ? 's' : ''} from discovery — review and edit them below` }); load() }} />
      )}

      {/* ── Add / Edit form ────────────────────────────────────── */}
      {showForm && (
        <form className="card" onSubmit={submit}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <Field label="Name">
              <input required value={form.name} onChange={e => setForm(x => ({ ...x, name: e.target.value }))} />
            </Field>
            <Field label="Status">
              <select value={form.status} onChange={e => setForm(x => ({ ...x, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <input list="svc-categories" value={form.category} style={{ width: 150 }}
                onChange={e => setForm(x => ({ ...x, category: e.target.value }))} />
            </Field>
            <Field label="Host (where it runs)">
              <input list="svc-hosts" value={form.host} style={{ width: 150 }}
                onChange={e => setForm(x => ({ ...x, host: e.target.value }))} />
            </Field>
            <Field label="Platform">
              <select value={form.platform} onChange={e => setForm(x => ({ ...x, platform: e.target.value }))}>
                <option value="">—</option>
                {PLATFORMS.map(p => <option key={p}>{p}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <Field label="IP address">
              <input list="svc-ips" value={form.ip} style={{ width: 140, fontFamily: 'monospace' }}
                onChange={e => setIp(e.target.value)} />
            </Field>
            <Field label="Protocol">
              <select value={form.protocol} onChange={e => setForm(x => ({ ...x, protocol: e.target.value }))}>
                {PROTOCOLS.map(p => <option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Port">
              <input type="number" value={form.port} style={{ width: 80 }}
                onChange={e => setForm(x => ({ ...x, port: e.target.value }))} />
            </Field>
            <Field label="VLAN">
              <input type="number" value={form.vlan} style={{ width: 70 }}
                onChange={e => setForm(x => ({ ...x, vlan: e.target.value }))} />
            </Field>
            <Field label="Access URL (proxied / public)">
              <input value={form.url} placeholder="https://app.example.com" style={{ width: 240 }}
                onChange={e => setForm(x => ({ ...x, url: e.target.value }))} />
            </Field>
            <Field label="Linked monitor">
              <select value={form.monitor_id} onChange={e => setForm(x => ({ ...x, monitor_id: e.target.value }))}>
                <option value="">None</option>
                {monitors.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <Check label="Behind reverse proxy" checked={form.proxied} onChange={v => setForm(x => ({ ...x, proxied: v }))} />
            <Check label="Behind SSO (Authentik)" checked={form.sso} onChange={v => setForm(x => ({ ...x, sso: v }))} />
            <Check label="Internet-facing" checked={form.external} onChange={v => setForm(x => ({ ...x, external: v }))} />
          </div>
          <Field label="External credentials — e.g. a Vaultwarden item link (use the Vault page to store passwords in BaumLab)">
            <input value={form.credential_ref} placeholder="https://vault.example.com/#/vault?itemId=…"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12 }}
              onChange={e => setForm(x => ({ ...x, credential_ref: e.target.value }))} />
          </Field>
          <Field label="Notes">
            <input value={form.notes} style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12 }}
              onChange={e => setForm(x => ({ ...x, notes: e.target.value }))} />
          </Field>
          {editId == null && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>ALSO CREATE</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <span title={form.monitor_id ? 'A monitor is already linked' : !form.ip ? 'Needs an IP address' : ''}>
                  <Check label="Health monitor for this IP / port" checked={extras.monitor && !form.monitor_id && !!form.ip}
                    onChange={v => setExtras(x => ({ ...x, monitor: v }))} />
                </span>
                {isAdmin && (
                  <Check label="Vault entry with login" checked={extras.vault}
                    onChange={v => setExtras(x => ({ ...x, vault: v }))} />
                )}
                {isAdmin && (
                  <Check label="Set up a backup job next" checked={extras.backup}
                    onChange={v => setExtras(x => ({ ...x, backup: v }))} />
                )}
              </div>
              {isAdmin && extras.vault && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <Field label="Username">
                    <input value={extras.vault_username} autoComplete="off"
                      onChange={e => setExtras(x => ({ ...x, vault_username: e.target.value }))} />
                  </Field>
                  <Field label="Password">
                    <input type="password" value={extras.vault_secret} autoComplete="new-password" style={{ width: 220 }}
                      onChange={e => setExtras(x => ({ ...x, vault_secret: e.target.value }))} />
                  </Field>
                </div>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit">{editId != null ? 'Save' : 'Add'}</button>
            <button type="button" className="secondary" onClick={cancelForm}>Cancel</button>
          </div>

          <datalist id="svc-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
          <datalist id="svc-hosts">{hosts.map(h => <option key={h} value={h} />)}</datalist>
          <datalist id="svc-ips">
            {devices.map(d => <option key={d.id} value={d.ip}>{d.label || d.hostname || ''}</option>)}
          </datalist>
        </form>
      )}

      {/* ── Grouped tables ─────────────────────────────────────── */}
      {services.length === 0 && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          No services yet. Click “🔍 Discover” to pull suggestions from Docker and your port scans,
          or “+ Add Service” to add one by hand.
        </div>
      )}
      {services.length > 0 && filtered.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No services match “{search}”.</div>
      )}

      {groups.map(([group, items]) => (
        <div key={group} style={{ marginBottom: 24 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {group}
            <span className="badge badge-gray">{items.length}</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Category</th>
                <th>Host</th>
                <th>IP : Port</th>
                <th>VLAN</th>
                <th>Access</th>
                <th>Backup</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => {
                const st     = s.monitor_id != null ? statusMap[s.monitor_id] : null
                const isUp   = st?.is_up === true
                const isDown = st?.is_up === false
                const dot    = isUp ? '#3fb950' : isDown ? '#f85149' : '#8b949e'
                const direct = directUrl(s)
                const ipPort = s.ip ? (s.port ? `${s.ip}:${s.port}` : s.ip) : s.port ? `:${s.port}` : '—'
                const isRetired = s.status === 'decommissioned'

                return (
                  <tr key={s.id} style={{
                    ...(editId === s.id ? { background: 'var(--bg2)' } : {}),
                    ...(isRetired ? { opacity: 0.5 } : {}),
                  }}>
                    <td title={s.monitor_id == null ? 'No monitor linked' : st?.error || ''}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: dot,
                          boxShadow: isDown ? `0 0 5px ${dot}` : 'none' }} />
                        <span style={{ fontSize: 12, color: dot }}>
                          {isUp ? 'Up' : isDown ? 'Down' : '—'}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={isRetired ? { textDecoration: 'line-through' } : {}}>{s.name}</span>
                        {s.status !== 'active' && (
                          <span className={`badge badge-${isRetired ? 'gray' : 'yellow'}`}>{s.status}</span>
                        )}
                        {vaultCounts[s.id] > 0 && (
                          <Link to={`/vault?service=${s.id}`} title="Credentials in BaumLab vault"
                            style={{ textDecoration: 'none', fontSize: 12, color: 'var(--text-muted)' }}>
                            🔒{vaultCounts[s.id] > 1 ? vaultCounts[s.id] : ''}
                          </Link>
                        )}
                        {s.credential_ref && (/^https?:\/\//.test(s.credential_ref)
                          ? <a href={s.credential_ref} target="_blank" rel="noreferrer" title="Open credentials in vault"
                              style={{ textDecoration: 'none' }}>🔑</a>
                          : <span title={`Credentials: ${s.credential_ref}`} style={{ cursor: 'help' }}>🔑</span>)}
                      </div>
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noreferrer"
                          style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
                          {s.url.replace(/^https?:\/\//, '')} ↗
                        </a>
                      )}
                    </td>
                    <td>{s.category || '—'}</td>
                    <td>
                      {s.host || '—'}
                      {s.platform && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{s.platform}</span>}
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>
                      {direct
                        ? <a href={direct} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>{ipPort}</a>
                        : ipPort}
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>{s.protocol}</span>
                    </td>
                    <td>{s.vlan ?? '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {s.proxied && <span className="badge badge-blue">Proxy</span>}
                        {s.sso && <span className="badge badge-green">SSO</span>}
                        {s.external && (
                          <span className={`badge badge-${s.sso ? 'yellow' : 'red'}`}
                            title={s.sso ? 'Internet-facing' : 'Internet-facing without SSO'}>
                            Public
                          </span>
                        )}
                        {!s.proxied && !s.sso && !s.external && <span className="badge badge-gray">Direct</span>}
                      </div>
                    </td>
                    <td>
                      {!isRetired && (() => {
                        const cov = backups[s.id]
                        const [color, label] = BACKUP_LABELS[cov?.status ?? 'none']
                        const badge = (
                          <span className={`badge badge-${color}`}
                            title={cov ? cov.sources.map(x => `${x.name} (${x.status})`).join('\n') : 'No backup job or record'}>
                            {label}
                          </span>
                        )
                        return isAdmin ? <Link to="/backups" style={{ textDecoration: 'none' }}>{badge}</Link> : badge
                      })()}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 260 }}>{s.notes || ''}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="secondary" onClick={() => openEdit(s)}>✎ Edit</button>
                        <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(s.id)}>✕</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

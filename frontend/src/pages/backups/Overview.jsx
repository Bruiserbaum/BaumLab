import React, { useEffect, useState } from 'react'
import { API, Field, Modal, StatusBadge, ago, apiJson, fmtBytes, fullDate } from './common'

function RecordForm({ api, service, record, onClose, onSaved, notify }) {
  const [form, setForm] = useState({
    method: record?.method ?? '', location: record?.location ?? '', frequency_days: record?.frequency_days ?? 7,
    notes: record?.notes ?? '',
  })
  const set = patch => setForm(f => ({ ...f, ...patch }))

  async function save(e) {
    e.preventDefault()
    const body = { ...form, service_id: service.id, frequency_days: +form.frequency_days }
    try {
      await apiJson(api, record ? `${API}/records/${record.id}` : `${API}/records`, {
        method: record ? 'PUT' : 'POST', body: JSON.stringify(body),
      })
      onSaved()
    } catch (err) { notify({ ok: false, text: err.message }) }
  }

  async function remove() {
    if (!confirm('Delete this backup record?')) return
    await apiJson(api, `${API}/records/${record.id}`, { method: 'DELETE' }).catch(e => notify({ ok: false, text: e.message }))
    onSaved()
  }

  return (
    <Modal title={`${record ? 'Edit' : 'Add'} external backup — ${service.name}`} onClose={onClose} width={520}>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        For backups made outside BaumLab (Unraid appdata backup, Proxmox vzdump, NAS snapshots…). Mark it
        verified when you've checked the copies exist — it goes stale after the expected interval.
      </p>
      <form onSubmit={save}>
        <Field label="Method"><input required value={form.method} placeholder="Unraid appdata backup" onChange={e => set({ method: e.target.value })} /></Field>
        <Field label="Where the copies live"><input value={form.location} placeholder="NAS /backups/appdata" onChange={e => set({ location: e.target.value })} /></Field>
        <Field label="Expected every (days)"><input type="number" min={1} value={form.frequency_days} style={{ width: 100 }} onChange={e => set({ frequency_days: e.target.value })} /></Field>
        <Field label="Notes"><input value={form.notes} onChange={e => set({ notes: e.target.value })} /></Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit">Save</button>
          {record && <button type="button" className="secondary" style={{ color: 'var(--red)', marginLeft: 'auto' }} onClick={remove}>Delete</button>}
        </div>
      </form>
    </Modal>
  )
}

export function Overview({ api, notify, onCreateJob, openRunLog }) {
  const [data, setData] = useState(null)
  const [records, setRecords] = useState([])
  const [recordFor, setRecordFor] = useState(null)   // { service, record? }
  const [filter, setFilter] = useState('all')

  async function load() {
    try {
      const [o, r] = await Promise.all([apiJson(api, `${API}/overview`), apiJson(api, `${API}/records`)])
      setData(o)
      setRecords(r)
    } catch (e) { notify({ ok: false, text: e.message }) }
  }
  useEffect(() => { load() }, [])

  async function verify(recordId) {
    await apiJson(api, `${API}/records/${recordId}/verify`, { method: 'POST' }).catch(e => notify({ ok: false, text: e.message }))
    load()
  }

  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const counts = { ok: 0, stale: 0, failed: 0, none: 0 }
  for (const s of data.services) {
    if (s.status === 'ok') counts.ok++
    else if (s.status === 'stale') counts.stale++
    else if (s.status === 'none') counts.none++
    else counts.failed++   // failed / never / disabled — protected on paper only
  }
  const shown = data.services.filter(s =>
    filter === 'all' || (filter === 'attention' ? s.status !== 'ok' : s.status === filter))

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['ok', 'Protected', 'var(--green)'], ['stale', 'Stale', 'var(--yellow)'],
          ['failed', 'Failing / never ran', 'var(--red)'], ['none', 'No backup', 'var(--red)']].map(([k, label, color]) => (
          <div key={k} className="card" style={{ marginBottom: 0, padding: '10px 16px', minWidth: 120, cursor: 'pointer',
            borderColor: filter === k ? color : 'var(--border)' }} onClick={() => setFilter(filter === k ? 'all' : k)}>
            <div style={{ fontSize: 20, fontWeight: 600, color: counts[k] && k !== 'ok' ? color : 'var(--text)' }}>{counts[k]}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
          </div>
        ))}
      </div>

      <div className="toolbar">
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All services</option>
          <option value="attention">Needs attention</option>
          <option value="none">No backup</option>
        </select>
        <button className="secondary" onClick={load}>Refresh</button>
      </div>

      <table>
        <thead><tr><th>Service</th><th>Backup</th><th>Protected by</th><th></th></tr></thead>
        <tbody>
          {shown.map(s => (
            <tr key={s.id}>
              <td>
                <div style={{ fontWeight: 500 }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{[s.host, s.category].filter(Boolean).join(' · ')}</div>
              </td>
              <td><StatusBadge status={s.status} /></td>
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {s.sources.map(src => {
                    const rec = src.kind === 'record' ? records.find(r => r.id === src.id) : null
                    return (
                      <div key={`${src.kind}:${src.id}`} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                        <StatusBadge status={src.status} />
                        <span className="badge badge-gray">{src.kind === 'record' ? 'external' : src.kind}</span>
                        <span style={{ cursor: rec ? 'pointer' : 'default', textDecoration: rec ? 'underline dotted' : 'none' }}
                          onClick={() => rec && setRecordFor({ service: s, record: rec })}>{src.name}</span>
                        <span style={{ color: 'var(--text-muted)' }} title={fullDate(src.last_success_at)}>{ago(src.last_success_at)}</span>
                        {rec && <button className="secondary" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => verify(rec.id)}>✓ verified now</button>}
                      </div>
                    )
                  })}
                  {s.sources.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>}
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="secondary" onClick={() => onCreateJob(s)}>+ Job</button>
                  <button className="secondary" onClick={() => setRecordFor({ service: s })}>+ External</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>Recent runs</h2>
      <RunsTable runs={data.recent_runs} openRunLog={openRunLog} />

      {recordFor && <RecordForm api={api} {...recordFor} notify={notify} onClose={() => setRecordFor(null)}
        onSaved={() => { setRecordFor(null); load() }} />}
    </div>
  )
}

export function RunsTable({ runs, openRunLog }) {
  if (runs.length === 0) return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No runs yet.</div>
  return (
    <table>
      <thead><tr><th>Status</th><th>Target</th><th>Type</th><th>Started</th><th>Duration</th><th>Size</th><th>Error</th></tr></thead>
      <tbody>
        {runs.map(r => {
          const secs = r.completed_at ? Math.round((new Date(r.completed_at + 'Z') - new Date(r.started_at + 'Z')) / 1000) : null
          return (
            <tr key={r.id} onClick={() => openRunLog(r.id)} style={{ cursor: 'pointer' }}>
              <td><StatusBadge status={r.status} /></td>
              <td>{r.name} <span className="badge badge-gray">{r.kind}</span></td>
              <td>{r.run_type}</td>
              <td style={{ fontSize: 12 }} title={fullDate(r.started_at)}>{ago(r.started_at)}</td>
              <td style={{ fontSize: 12 }}>{secs == null ? '…' : secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}</td>
              <td style={{ fontSize: 12 }}>{fmtBytes(r.size_bytes)}</td>
              <td style={{ fontSize: 12, color: 'var(--red)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error || ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function History({ api, filter, setFilter, openRunLog, notify }) {
  const [runs, setRuns] = useState([])
  async function load() {
    const q = new URLSearchParams({ limit: '200' })
    if (filter) { q.set('kind', filter.kind); q.set('target_id', filter.id) }
    try { setRuns(await apiJson(api, `${API}/runs?${q}`)) } catch (e) { notify({ ok: false, text: e.message }) }
  }
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [filter])
  return (
    <div>
      <div className="toolbar">
        {filter && <>
          <span style={{ fontSize: 13 }}>Showing one {filter.kind}</span>
          <button className="secondary" onClick={() => setFilter(null)}>Show all</button>
        </>}
        <button className="secondary" onClick={load}>Refresh</button>
      </div>
      <RunsTable runs={runs} openRunLog={openRunLog} />
    </div>
  )
}

export function ImportTab({ api, notify, onImported }) {
  const [file, setFile] = useState(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('secret_key', secret)
    try {
      const r = await apiJson(api, `${API}/import`, { method: 'POST', body: fd })
      notify({ ok: true, text: `Imported ${r.destinations} destination(s), ${r.jobs} job(s), ${r.stacks} stack(s) — jobs are disabled until you enable them` })
      onImported()
    } catch (err) { notify({ ok: false, text: err.message }) }
    setBusy(false)
  }

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>Import from BaumLabBackup</h2>
      <ol style={{ fontSize: 13, color: 'var(--text-muted)', paddingLeft: 18, lineHeight: 1.7, marginTop: 0 }}>
        <li>On the Docker host, copy the database out of the BaumLabBackup volume:<br />
          <code>docker cp baumlabbackup:/data/baumlabbackup.db ./baumlabbackup.db</code></li>
        <li>Upload it below with BaumLabBackup's <code>SECRET_KEY</code> (needed to decrypt destination
          credentials and DB passwords; kept encrypted so old stack archives' .env files stay readable).</li>
        <li>Jobs and stacks come in <b>disabled</b>. Stop BaumLabBackup, then enable them here so nothing runs twice.</li>
      </ol>
      <form onSubmit={submit}>
        <Field label="baumlabbackup.db">
          <input type="file" required accept=".db,.sqlite,application/octet-stream" onChange={e => setFile(e.target.files[0])} />
        </Field>
        <Field label="BaumLabBackup SECRET_KEY">
          <input type="password" required autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} />
        </Field>
        <button type="submit" disabled={busy || !file}>{busy ? 'Importing…' : 'Import'}</button>
      </form>
    </div>
  )
}

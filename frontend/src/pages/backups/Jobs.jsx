import React, { useEffect, useMemo, useState } from 'react'
import { API, CRON_PRESETS, Field, Modal, StatusBadge, ago, apiJson, fmtBytes, fullDate, ServicePicker } from './common'

const blankJob = {
  name: '', containers: [], volumes: [], db_type: '', db_container: '', db_name: '', db_user: '', db_password: '',
  destination_id: '', schedule_cron: '0 3 * * *', pre_stop: false, retention_days: 30, enabled: true, service_ids: [],
}
const mountKey = m => `${m.type}:${m.source}`

export function JobForm({ api, initial, destinations, services, onSaved, onCancel, notify }) {
  const [form, setForm] = useState({ ...blankJob, destination_id: destinations[0]?.id ?? '', ...initial })
  const [containers, setContainers] = useState([])
  const [dockerError, setDockerError] = useState('')
  const [saving, setSaving] = useState(false)
  const editing = initial?.id != null

  useEffect(() => {
    apiJson(api, `${API}/docker/containers`).then(setContainers).catch(e => setDockerError(e.message))
  }, [])

  const set = patch => setForm(f => ({ ...f, ...patch }))

  // Mount candidates: everything mounted by the selected containers, plus anything already in the job
  const candidates = useMemo(() => {
    const map = new Map(form.volumes.map(m => [mountKey(m), m]))
    for (const c of containers.filter(c => form.containers.includes(c.name))) {
      for (const m of c.mounts) if (!map.has(mountKey(m))) map.set(mountKey(m), { type: m.type, source: m.source, name: m.name, from: c.name })
    }
    return [...map.values()]
  }, [containers, form.containers, form.volumes])

  function toggleContainer(c, on) {
    const containers_ = on ? [...form.containers, c.name] : form.containers.filter(n => n !== c.name)
    // Selecting a container selects its mounts too; deselecting drops mounts only it provided
    let volumes = form.volumes
    if (on) {
      const have = new Set(volumes.map(mountKey))
      volumes = [...volumes, ...c.mounts.filter(m => !have.has(mountKey(m))).map(m => ({ type: m.type, source: m.source, name: m.name }))]
    } else {
      const stillUsed = new Set(containers.filter(x => containers_.includes(x.name)).flatMap(x => x.mounts.map(mountKey)))
      const own = new Set(c.mounts.map(mountKey))
      volumes = volumes.filter(m => !own.has(mountKey(m)) || stillUsed.has(mountKey(m)))
    }
    set({ containers: containers_, volumes, name: form.name || c.name })
  }

  function toggleMount(m, on) {
    set({ volumes: on ? [...form.volumes, { type: m.type, source: m.source, name: m.name }]
                      : form.volumes.filter(v => mountKey(v) !== mountKey(m)) })
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    const body = {
      ...form,
      destination_id: +form.destination_id,
      retention_days: +form.retention_days,
      db_type: form.db_type || null,
      db_container: form.db_type ? form.db_container || null : null,
      db_name: form.db_type ? form.db_name || null : null,
      db_user: form.db_type ? form.db_user || null : null,
      db_password: form.db_password || null,
    }
    try {
      const saved = await apiJson(api, editing ? `${API}/jobs/${initial.id}` : `${API}/jobs`, {
        method: editing ? 'PUT' : 'POST', body: JSON.stringify(body),
      })
      onSaved(saved)
    } catch (err) {
      notify({ ok: false, text: err.message })
    }
    setSaving(false)
  }

  const byProject = useMemo(() => {
    const groups = {}
    for (const c of containers) (groups[c.project || 'Standalone'] ??= []).push(c)
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
  }, [containers])

  if (destinations.length === 0) {
    return <div className="card" style={{ color: 'var(--text-muted)' }}>Add a destination first (Destinations tab).</div>
  }

  return (
    <form className="card" onSubmit={save}>
      <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>{editing ? `Edit ${initial.name}` : 'New backup job'}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <div>
          <Field label="Name"><input required value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Field label="Containers" hint="stopped during backup if 'Stop containers' is on">
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {dockerError && <div style={{ fontSize: 12, color: 'var(--red)' }}>{dockerError}</div>}
              {byProject.map(([project, list]) => (
                <div key={project} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{project}</div>
                  {list.map(c => (
                    <label key={c.name} style={{ display: 'flex', gap: 6, fontSize: 12, alignItems: 'center' }}>
                      <input type="checkbox" checked={form.containers.includes(c.name)} onChange={e => toggleContainer(c, e.target.checked)} />
                      {c.name} <span style={{ color: 'var(--text-muted)' }}>({c.status})</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </Field>
        </div>
        <div>
          <Field label="Data to archive" hint="volumes and bind mounts">
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {candidates.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Select containers to see their mounts</span>}
              {candidates.map(m => (
                <label key={mountKey(m)} style={{ display: 'flex', gap: 6, fontSize: 12, alignItems: 'center' }}>
                  <input type="checkbox" checked={form.volumes.some(v => mountKey(v) === mountKey(m))}
                    onChange={e => toggleMount(m, e.target.checked)} />
                  <span className={`badge badge-${m.type === 'volume' ? 'blue' : 'gray'}`}>{m.type}</span>
                  <code style={{ wordBreak: 'break-all' }}>{m.source}</code>
                </label>
              ))}
            </div>
          </Field>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={form.pre_stop} onChange={e => set({ pre_stop: e.target.checked })} />
            Stop containers while archiving (consistent copy; restarted before upload)
          </label>
        </div>
        <div>
          <Field label="Database dump" hint="taken before containers stop">
            <select value={form.db_type || ''} onChange={e => set({ db_type: e.target.value })}>
              <option value="">None</option>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
            </select>
          </Field>
          {form.db_type && <>
            <Field label="Database container">
              <select required value={form.db_container || ''} onChange={e => set({ db_container: e.target.value })}>
                <option value="">— choose —</option>
                {containers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <Field label="Database"><input required value={form.db_name || ''} onChange={e => set({ db_name: e.target.value })} /></Field>
              <Field label="User"><input required value={form.db_user || ''} onChange={e => set({ db_user: e.target.value })} /></Field>
            </div>
            <Field label="Password" hint={initial?.has_db_password ? 'saved — blank keeps it' : ''}>
              <input type="password" autoComplete="new-password" value={form.db_password || ''}
                onChange={e => set({ db_password: e.target.value })} />
            </Field>
          </>}
        </div>
        <div>
          <Field label="Destination">
            <select required value={form.destination_id} onChange={e => set({ destination_id: e.target.value })}>
              {destinations.map(d => <option key={d.id} value={d.id}>{d.name} ({d.type})</option>)}
            </select>
          </Field>
          <Field label="Schedule (cron)" hint="minute hour day month weekday">
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={CRON_PRESETS.some(([c]) => c === form.schedule_cron) ? form.schedule_cron : ''}
                onChange={e => e.target.value && set({ schedule_cron: e.target.value })}>
                <option value="">Custom…</option>
                {CRON_PRESETS.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
              </select>
              <input required value={form.schedule_cron} style={{ width: 120, fontFamily: 'monospace' }}
                onChange={e => set({ schedule_cron: e.target.value })} />
            </div>
          </Field>
          <Field label="Keep archives for (days)" hint="0 = forever">
            <input type="number" min={0} value={form.retention_days} style={{ width: 100 }}
              onChange={e => set({ retention_days: e.target.value })} />
          </Field>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} />
            Enabled (runs on schedule)
          </label>
        </div>
      </div>
      <Field label="Protects these services">
        <ServicePicker services={services} value={form.service_ids} onChange={ids => set({ service_ids: ids })} />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Create job'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function RestoreJob({ api, job, onClose, notify }) {
  const [archives, setArchives] = useState(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState('')
  const [mounts, setMounts] = useState(true)
  const [db, setDb] = useState(!!job.db_type)
  const [start, setStart] = useState(job.containers)

  useEffect(() => {
    apiJson(api, `${API}/jobs/${job.id}/archives`)
      .then(list => { setArchives(list); setChosen(list[0]?.name ?? '') })
      .catch(e => setError(e.message))
  }, [])

  async function restore() {
    if (!confirm(`Restore ${job.name} from ${chosen}?\n\nThe job's containers are stopped and the selected data is REPLACED with the backup's contents.`)) return
    try {
      await apiJson(api, `${API}/jobs/${job.id}/restore`, {
        method: 'POST', body: JSON.stringify({ filename: chosen, restore_mounts: mounts, restore_db: db, start_after: start }),
      })
      notify({ ok: true, text: `Restore of ${job.name} started — follow it in History` })
      onClose()
    } catch (e) { setError(e.message) }
  }

  return (
    <Modal title={`Restore ${job.name}`} onClose={onClose}>
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {!archives && !error && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Listing archives…</div>}
      {archives && archives.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No archives found for this job.</div>}
      {archives && archives.length > 0 && <>
        <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 12 }}>
          <table>
            <thead><tr><th></th><th>Archive</th><th>Size</th><th>Date</th></tr></thead>
            <tbody>
              {archives.map(a => (
                <tr key={a.name} onClick={() => setChosen(a.name)} style={{ cursor: 'pointer' }}>
                  <td><input type="radio" checked={chosen === a.name} onChange={() => setChosen(a.name)} /></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.name}</td>
                  <td>{fmtBytes(a.size)}</td>
                  <td style={{ fontSize: 12 }}>{fullDate(a.modified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={mounts} onChange={e => setMounts(e.target.checked)} /> Restore volumes / bind mounts
        </label>
        {job.db_type && (
          <label style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 6 }}>
            <input type="checkbox" checked={db} onChange={e => setDb(e.target.checked)} /> Restore database dump into {job.db_container}
          </label>
        )}
        {job.containers.length > 0 && (
          <Field label="Start afterwards">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
              {job.containers.map(c => (
                <label key={c} style={{ fontSize: 12, display: 'flex', gap: 5 }}>
                  <input type="checkbox" checked={start.includes(c)}
                    onChange={e => setStart(e.target.checked ? [...start, c] : start.filter(x => x !== c))} />{c}
                </label>
              ))}
            </div>
          </Field>
        )}
        <button onClick={restore} disabled={!chosen || (!mounts && !db)} style={{ background: 'var(--red)' }}>Restore</button>
      </>}
    </Modal>
  )
}

export default function Jobs({ api, destinations, services, notify, openRun, prefill, clearPrefill }) {
  const [jobs, setJobs] = useState([])
  const [editing, setEditing] = useState(null)    // null | {} (new) | job
  const [restoring, setRestoring] = useState(null)

  async function load() {
    try { setJobs(await apiJson(api, `${API}/jobs`)) } catch (e) { notify({ ok: false, text: e.message }) }
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])
  useEffect(() => { if (prefill) { setEditing(prefill); clearPrefill() } }, [prefill])

  async function runNow(job) {
    try {
      await apiJson(api, `${API}/jobs/${job.id}/run`, { method: 'POST' })
      notify({ ok: true, text: `${job.name} started` })
      setTimeout(load, 1500)
    } catch (e) { notify({ ok: false, text: e.message }) }
  }

  async function remove(job) {
    if (!confirm(`Delete job ${job.name}? Archives already uploaded are kept.`)) return
    await apiJson(api, `${API}/jobs/${job.id}`, { method: 'DELETE' }).catch(e => notify({ ok: false, text: e.message }))
    load()
  }

  const destName = id => destinations.find(d => d.id === id)?.name ?? '—'
  const svcNames = ids => ids.map(id => services.find(s => s.id === id)?.name).filter(Boolean).join(', ')

  return (
    <div>
      {editing ? (
        <JobForm api={api} initial={editing} destinations={destinations} services={services} notify={notify}
          onCancel={() => setEditing(null)}
          onSaved={j => { setEditing(null); notify({ ok: true, text: `Saved ${j.name}` }); load() }} />
      ) : (
        <div className="toolbar"><button onClick={() => setEditing({})}>+ New job</button></div>
      )}

      {jobs.length === 0 && !editing && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          No backup jobs yet. Create one, or import your BaumLabBackup setup from the Import tab.
        </div>
      )}
      {jobs.length > 0 && (
        <table>
          <thead>
            <tr><th>Status</th><th>Job</th><th>Data</th><th>Destination</th><th>Schedule</th><th>Last success</th><th>Next run</th><th></th></tr>
          </thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.id}>
                <td>{j.running ? <StatusBadge status="running" /> : <StatusBadge status={j.freshness} title={j.last_run_status ? `Last run: ${j.last_run_status}` : ''} />}</td>
                <td>
                  <div style={{ fontWeight: 500 }}>{j.name}</div>
                  {j.service_ids.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{svcNames(j.service_ids)}</div>}
                </td>
                <td style={{ fontSize: 12 }}>
                  {j.volumes.length} mount{j.volumes.length !== 1 ? 's' : ''}{j.db_type && ` + ${j.db_type} dump`}
                  {j.pre_stop && <span className="badge badge-gray" style={{ marginLeft: 6 }}>stops</span>}
                </td>
                <td>{destName(j.destination_id)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{j.schedule_cron}</td>
                <td style={{ fontSize: 12 }} title={fullDate(j.last_success_at)}>{ago(j.last_success_at)}</td>
                <td style={{ fontSize: 12 }}>{j.enabled ? ago(j.next_run) : '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="secondary" disabled={j.running} onClick={() => runNow(j)}>▶ Run</button>
                    <button className="secondary" onClick={() => setRestoring(j)}>Restore</button>
                    <button className="secondary" onClick={() => openRun({ kind: 'job', id: j.id })}>History</button>
                    <button className="secondary" onClick={() => setEditing(j)}>✎</button>
                    <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(j)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restoring && <RestoreJob api={api} job={restoring} notify={notify} onClose={() => { setRestoring(null); load() }} />}
    </div>
  )
}

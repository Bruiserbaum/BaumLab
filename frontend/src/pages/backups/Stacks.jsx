import React, { useEffect, useState } from 'react'
import { API, CRON_PRESETS, Field, Modal, StatusBadge, ago, apiJson, fmtBytes, fullDate, ServicePicker } from './common'

const blankStack = {
  name: '', compose_project: '', volumes: [], repo_url: '', repo_branch: 'main', env_path: '',
  destination_id: '', schedule_cron: '0 3 * * 0', retention_days: 30, enabled: true, service_ids: [],
}

function StackForm({ api, initial, destinations, services, onSaved, onCancel, notify }) {
  const [form, setForm] = useState({ ...blankStack, destination_id: destinations[0]?.id ?? '', ...initial,
                                     schedule_cron: initial?.id != null ? initial.schedule_cron ?? '' : blankStack.schedule_cron })
  const [detected, setDetected] = useState([])
  const editing = initial?.id != null
  const set = patch => setForm(f => ({ ...f, ...patch }))

  useEffect(() => {
    apiJson(api, `${API}/docker/stacks`).then(setDetected).catch(e => notify({ ok: false, text: e.message }))
  }, [])

  const project = detected.find(p => p.compose_project === form.compose_project)
  const volumeChoices = [...new Set([...(project?.volumes ?? []), ...form.volumes])]

  function pickProject(name) {
    const p = detected.find(x => x.compose_project === name)
    set({ compose_project: name, volumes: p?.volumes ?? [], name: form.name || name })
  }

  async function save(e) {
    e.preventDefault()
    const body = { ...form, destination_id: +form.destination_id, retention_days: +form.retention_days,
                   schedule_cron: form.schedule_cron || null }
    try {
      const saved = await apiJson(api, editing ? `${API}/stacks/${initial.id}` : `${API}/stacks`, {
        method: editing ? 'PUT' : 'POST', body: JSON.stringify(body),
      })
      onSaved(saved)
    } catch (err) { notify({ ok: false, text: err.message }) }
  }

  if (destinations.length === 0) {
    return <div className="card" style={{ color: 'var(--text-muted)' }}>Add a destination first (Destinations tab).</div>
  }

  return (
    <form className="card" onSubmit={save}>
      <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>{editing ? `Edit ${initial.name}` : 'New stack backup'}</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Disaster-recovery copy of a compose stack: its named volumes, its environment (encrypted) and the
        repo it deploys from — everything needed to redeploy it in Portainer on a fresh host.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <div>
          <Field label="Compose project">
            <select required value={form.compose_project} onChange={e => pickProject(e.target.value)}>
              <option value="">— choose a running stack —</option>
              {detected.map(p => <option key={p.compose_project} value={p.compose_project}>{p.compose_project} ({p.containers.length} containers)</option>)}
              {form.compose_project && !project && <option value={form.compose_project}>{form.compose_project} (not running)</option>}
            </select>
          </Field>
          <Field label="Name"><input required value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Field label="Volumes">
            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {volumeChoices.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>This stack has no named volumes</span>}
              {volumeChoices.map(v => (
                <label key={v} style={{ display: 'flex', gap: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={form.volumes.includes(v)}
                    onChange={e => set({ volumes: e.target.checked ? [...form.volumes, v] : form.volumes.filter(x => x !== v) })} />
                  <code>{v}</code>
                </label>
              ))}
            </div>
          </Field>
        </div>
        <div>
          <Field label="Git repository" hint="where the stack's compose file lives">
            <input value={form.repo_url} placeholder="https://github.com/you/stack" onChange={e => set({ repo_url: e.target.value })} />
          </Field>
          <Field label="Branch"><input value={form.repo_branch} onChange={e => set({ repo_branch: e.target.value })} /></Field>
          <Field label=".env path" hint="optional — otherwise env vars are read from the running containers">
            <input value={form.env_path} placeholder="(read from containers)" onChange={e => set({ env_path: e.target.value })} />
          </Field>
        </div>
        <div>
          <Field label="Destination">
            <select required value={form.destination_id} onChange={e => set({ destination_id: e.target.value })}>
              {destinations.map(d => <option key={d.id} value={d.id}>{d.name} ({d.type})</option>)}
            </select>
          </Field>
          <Field label="Schedule (cron)" hint="blank = manual only">
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={CRON_PRESETS.some(([c]) => c === form.schedule_cron) ? form.schedule_cron : ''}
                onChange={e => set({ schedule_cron: e.target.value })}>
                <option value="">Manual / custom…</option>
                {CRON_PRESETS.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
              </select>
              <input value={form.schedule_cron || ''} style={{ width: 120, fontFamily: 'monospace' }}
                onChange={e => set({ schedule_cron: e.target.value })} />
            </div>
          </Field>
          <Field label="Keep archives for (days)">
            <input type="number" min={0} value={form.retention_days} style={{ width: 100 }}
              onChange={e => set({ retention_days: e.target.value })} />
          </Field>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} /> Enabled
          </label>
        </div>
      </div>
      <Field label="Protects these services">
        <ServicePicker services={services} value={form.service_ids} onChange={ids => set({ service_ids: ids })} />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit">{editing ? 'Save' : 'Create stack backup'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function StackArchives({ api, stack, onClose, notify }) {
  const [archives, setArchives] = useState(null)
  const [error, setError] = useState('')
  const [env, setEnv] = useState(null)

  useEffect(() => {
    apiJson(api, `${API}/stacks/${stack.id}/archives`).then(setArchives).catch(e => setError(e.message))
  }, [])

  async function restore(name) {
    if (!confirm(`Restore volumes of ${stack.name} from ${name}?\n\nRunning containers of this stack are stopped and its volumes are REPLACED.`)) return
    try {
      await apiJson(api, `${API}/stacks/${stack.id}/restore`, { method: 'POST', body: JSON.stringify({ filename: name }) })
      notify({ ok: true, text: `Restore of ${stack.name} started — follow it in History` })
      onClose()
    } catch (e) { setError(e.message) }
  }

  async function showEnv(name) {
    setError('')
    try { setEnv({ name, ...(await apiJson(api, `${API}/stacks/${stack.id}/env`, { method: 'POST', body: JSON.stringify({ filename: name }) })) }) }
    catch (e) { setError(e.message) }
  }

  return (
    <Modal title={`${stack.name} — archives`} onClose={onClose} width={820}>
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {!archives && !error && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Listing…</div>}
      {archives && archives.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No archives yet.</div>}
      {archives && archives.length > 0 && (
        <table>
          <thead><tr><th>Archive</th><th>Size</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {archives.map(a => (
              <tr key={a.name}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.name}</td>
                <td>{fmtBytes(a.size)}</td>
                <td style={{ fontSize: 12 }}>{fullDate(a.modified)}</td>
                <td style={{ display: 'flex', gap: 4 }}>
                  <button className="secondary" onClick={() => showEnv(a.name)}>View .env</button>
                  <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => restore(a.name)}>Restore volumes</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {env && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
            From {env.name} — redeploy in Portainer from <code>{env.repo_url || '(no repo recorded)'}</code> @ <code>{env.repo_branch}</code>,
            pasting these into the stack's environment variables (Advanced mode). This view is logged in the vault audit.
          </div>
          {env.env
            ? <textarea readOnly value={env.env} rows={10} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace',
                fontSize: 12, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }} />
            : <div style={{ fontSize: 12, color: 'var(--yellow)' }}>This archive has no saved environment.</div>}
        </div>
      )}
    </Modal>
  )
}

export default function Stacks({ api, destinations, services, notify, openRun }) {
  const [stacks, setStacks] = useState([])
  const [editing, setEditing] = useState(null)
  const [browsing, setBrowsing] = useState(null)

  async function load() {
    try { setStacks(await apiJson(api, `${API}/stacks`)) } catch (e) { notify({ ok: false, text: e.message }) }
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])

  async function runNow(s) {
    try {
      await apiJson(api, `${API}/stacks/${s.id}/run`, { method: 'POST' })
      notify({ ok: true, text: `Backing up ${s.name}` })
      setTimeout(load, 1500)
    } catch (e) { notify({ ok: false, text: e.message }) }
  }

  async function remove(s) {
    if (!confirm(`Delete stack backup ${s.name}? Uploaded archives are kept.`)) return
    await apiJson(api, `${API}/stacks/${s.id}`, { method: 'DELETE' }).catch(e => notify({ ok: false, text: e.message }))
    load()
  }

  return (
    <div>
      {editing ? (
        <StackForm api={api} initial={editing} destinations={destinations} services={services} notify={notify}
          onCancel={() => setEditing(null)}
          onSaved={s => { setEditing(null); notify({ ok: true, text: `Saved ${s.name}` }); load() }} />
      ) : (
        <div className="toolbar"><button onClick={() => setEditing({})}>+ New stack backup</button></div>
      )}
      {stacks.length === 0 && !editing && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No stack backups yet.</div>
      )}
      {stacks.length > 0 && (
        <table>
          <thead><tr><th>Status</th><th>Stack</th><th>Volumes</th><th>Repo</th><th>Schedule</th><th>Last success</th><th></th></tr></thead>
          <tbody>
            {stacks.map(s => (
              <tr key={s.id}>
                <td>{s.running ? <StatusBadge status="running" /> : <StatusBadge status={s.freshness} />}</td>
                <td><div style={{ fontWeight: 500 }}>{s.name}</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.compose_project}</div></td>
                <td>{s.volumes.length}</td>
                <td style={{ fontSize: 12 }}>{s.repo_url ? `${s.repo_url.replace(/^https?:\/\//, '')} @ ${s.repo_branch}` : '—'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.schedule_cron || 'manual'}</td>
                <td style={{ fontSize: 12 }} title={fullDate(s.last_success_at)}>{ago(s.last_success_at)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="secondary" disabled={s.running} onClick={() => runNow(s)}>▶ Back up</button>
                    <button className="secondary" onClick={() => setBrowsing(s)}>Archives</button>
                    <button className="secondary" onClick={() => openRun({ kind: 'stack', id: s.id })}>History</button>
                    <button className="secondary" onClick={() => setEditing(s)}>✎</button>
                    <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(s)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {browsing && <StackArchives api={api} stack={browsing} notify={notify} onClose={() => { setBrowsing(null); load() }} />}
    </div>
  )
}

import React, { useEffect, useState } from 'react'
import { API, CRON_PRESETS, Field, Modal, StatusBadge, ago, apiJson, fmtBytes, fullDate, ServicePicker } from './common'

const blankKit = {
  name: '', connection: '', endpoint_id: '', endpoint_name: '', project: null, containers: [], exclude_mounts: [],
  dump_databases: true, stop_during_backup: false, cold_copy_fallback: true, destination_id: '', schedule_cron: '30 3 * * *',
  retention_days: 30, enabled: true, service_ids: [],
}

// Readable, unambiguous characters for a generated passphrase
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
function generatePassphrase() {
  const bytes = crypto.getRandomValues(new Uint8Array(25))
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('')
  return chars.match(/.{5}/g).join('-')
}

function PassphraseCard({ api, status, onChange, notify }) {
  const [open, setOpen] = useState(!status?.set)
  const [value, setValue] = useState('')
  const [confirmValue, setConfirmValue] = useState('')
  const [saved, setSaved] = useState(false)

  async function save(e) {
    e.preventDefault()
    if (value !== confirmValue) { notify({ ok: false, text: 'The two passphrases don\'t match' }); return }
    if (!saved) { notify({ ok: false, text: 'Tick the box once the passphrase is stored somewhere outside BaumLab' }); return }
    try {
      onChange(await apiJson(api, `${API}/passphrase`, { method: 'PUT', body: JSON.stringify({ passphrase: value }) }))
      setValue(''); setConfirmValue(''); setSaved(false); setOpen(false)
      notify({ ok: true, text: 'Recovery passphrase saved' })
    } catch (err) { notify({ ok: false, text: err.message }) }
  }

  return (
    <div className="card" style={{ borderColor: status?.set ? 'var(--border)' : 'var(--yellow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ color: 'var(--text)', fontSize: 14 }}>Recovery passphrase</b>
        {status?.set
          ? <span className="badge badge-green">set {status.set_at ? ago(status.set_at) : ''}</span>
          : <span className="badge badge-yellow">not set — kits can't run yet</span>}
        <button className="secondary" style={{ marginLeft: 'auto' }} onClick={() => setOpen(o => !o)}>
          {open ? 'Cancel' : status?.set ? 'Change' : 'Set passphrase'}
        </button>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
        Encrypts the secrets inside every kit (environment variables, settings). It's what lets you open a kit after
        BaumLab itself is gone — on a fresh BaumLab, or with the <code>decrypt-secrets.py</code> script inside each kit.
        <b> Keep a copy in your password manager or on paper: BaumLab can't show it again.</b>
      </p>
      {open && (
        <form onSubmit={save} style={{ marginTop: 12 }}>
          {status?.set && (
            <div style={{ fontSize: 12, color: 'var(--yellow)', marginBottom: 8 }}>
              Kits already made keep the old passphrase — keep it until those archives have expired.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Passphrase" hint="12+ characters" style={{ marginBottom: 0 }}>
              <input value={value} onChange={e => setValue(e.target.value)} style={{ width: 260, fontFamily: 'monospace' }}
                autoComplete="new-password" />
            </Field>
            <Field label="Again" style={{ marginBottom: 0 }}>
              <input value={confirmValue} onChange={e => setConfirmValue(e.target.value)} style={{ width: 260, fontFamily: 'monospace' }}
                autoComplete="new-password" />
            </Field>
            <button type="button" className="secondary" onClick={() => { const p = generatePassphrase(); setValue(p); setConfirmValue(p) }}>
              Generate
            </button>
          </div>
          <label style={{ display: 'flex', gap: 6, fontSize: 13, margin: '10px 0' }}>
            <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />
            I've stored this passphrase outside BaumLab
          </label>
          <button type="submit">Save passphrase</button>
        </form>
      )}
    </div>
  )
}

function VaultBackupCard({ api, destinations, passphraseSet, notify, openRun }) {
  const [status, setStatus] = useState(null)
  const [form, setForm] = useState(null)
  const [archives, setArchives] = useState(null)
  const [restorePass, setRestorePass] = useState('')
  const [busy, setBusy] = useState(false)
  const set = patch => setForm(f => ({ ...f, ...patch }))

  async function load() {
    try {
      const s = await apiJson(api, `${API}/vault-backup`)
      setStatus(s)
      setForm(f => f ?? { destination_id: s.destination_id ?? destinations[0]?.id ?? '', schedule_cron: s.schedule_cron || '',
                          retention_days: s.retention_days, enabled: s.enabled })
    } catch (e) { notify({ ok: false, text: e.message }) }
  }
  useEffect(() => { load() }, [])

  async function save(e) {
    e.preventDefault()
    try {
      setStatus(await apiJson(api, `${API}/vault-backup`, { method: 'PUT', body: JSON.stringify({
        ...form, destination_id: form.destination_id === '' ? null : +form.destination_id,
        retention_days: +form.retention_days, schedule_cron: form.schedule_cron || null }) }))
      notify({ ok: true, text: 'Vault backup settings saved' })
    } catch (err) { notify({ ok: false, text: err.message }) }
  }

  async function runNow() {
    try {
      await apiJson(api, `${API}/vault-backup/run`, { method: 'POST' })
      notify({ ok: true, text: 'Backing up the vault — result in History' })
      setTimeout(load, 2000)
    } catch (e) { notify({ ok: false, text: e.message }) }
  }

  async function download() {
    const r = await api(`${API}/vault-backup/download`, { method: 'POST' })
    if (!r.ok) { notify({ ok: false, text: (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}` }); return }
    const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'baumlab-vault.enc'
    const url = URL.createObjectURL(await r.blob())
    Object.assign(document.createElement('a'), { href: url, download: name }).click()
    URL.revokeObjectURL(url)
  }

  async function restore(filename) {
    if (!confirm(`Restore vault entries from ${filename}? Entries that already exist (same title and username) are left as they are.`)) return
    setBusy(true)
    try {
      const r = await apiJson(api, `${API}/vault-backup/restore`, { method: 'POST', body: JSON.stringify({ filename, passphrase: restorePass || null }) })
      notify({ ok: true, text: `Vault restored: ${r.added} entr${r.added === 1 ? 'y' : 'ies'} added, ${r.skipped} already there` })
    } catch (e) { notify({ ok: false, text: e.message }) } finally { setBusy(false) }
  }

  async function importFile(file) {
    if (!file) return
    const body = new FormData()
    body.append('file', file)
    body.append('passphrase', restorePass)
    setBusy(true)
    try {
      const r = await apiJson(api, `${API}/vault-backup/import`, { method: 'POST', body })
      notify({ ok: true, text: `Vault restored: ${r.added} added, ${r.skipped} already there` })
    } catch (e) { notify({ ok: false, text: e.message }) } finally { setBusy(false) }
  }

  if (!status || !form) return null
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ color: 'var(--text)', fontSize: 14 }}>Vault backup</b>
        {status.running ? <StatusBadge status="running" /> : <StatusBadge status={status.freshness} />}
        {status.last_success_at && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>last good {ago(status.last_success_at)}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button className="secondary" disabled={!passphraseSet || status.running || !status.destination_id} onClick={runNow}>▶ Back up</button>
          <button className="secondary" disabled={!passphraseSet} onClick={download} title="Download the whole vault, encrypted with the recovery passphrase">⬇ Encrypted copy</button>
          <button className="secondary" onClick={() => openRun({ kind: 'vault', id: 0 })}>History</button>
        </div>
      </div>
      <p style={{ margin: '8px 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Every vault entry, encrypted with the recovery passphrase — readable without BaumLab using the included
        <code> decrypt-secrets.py</code>, and restorable into a fresh BaumLab.
      </p>
      <form onSubmit={save} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Destination" style={{ marginBottom: 0 }}>
          <select value={form.destination_id ?? ''} onChange={e => set({ destination_id: e.target.value })}>
            <option value="">— choose —</option>
            {destinations.map(d => <option key={d.id} value={d.id}>{d.name} ({d.type})</option>)}
          </select>
        </Field>
        <Field label="Schedule (cron)" style={{ marginBottom: 0 }}>
          <input value={form.schedule_cron} style={{ width: 120, fontFamily: 'monospace' }} onChange={e => set({ schedule_cron: e.target.value })} />
        </Field>
        <Field label="Keep (days)" style={{ marginBottom: 0 }}>
          <input type="number" min={0} value={form.retention_days} style={{ width: 80 }} onChange={e => set({ retention_days: e.target.value })} />
        </Field>
        <label style={{ display: 'flex', gap: 6, fontSize: 13, paddingBottom: 8 }}>
          <input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} /> Scheduled
        </label>
        <button type="submit">Save</button>
      </form>
      <details style={{ marginTop: 12 }} onToggle={e => {
        if (e.target.open && archives === null && status.destination_id)
          apiJson(api, `${API}/vault-backup/archives`).then(setArchives).catch(err => { setArchives([]); notify({ ok: false, text: err.message }) })
      }}>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>Restore…</summary>
        <div style={{ marginTop: 8 }}>
          <Field label="Passphrase" hint="only if the backup was made with an older passphrase">
            <input type="password" value={restorePass} onChange={e => setRestorePass(e.target.value)} style={{ width: 260 }} autoComplete="off" />
          </Field>
          {archives?.length > 0 && (
            <table>
              <thead><tr><th>Backup</th><th>Size</th><th>Date</th><th></th></tr></thead>
              <tbody>
                {archives.slice(0, 20).map(a => (
                  <tr key={a.name}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.name}</td>
                    <td>{fmtBytes(a.size)}</td>
                    <td style={{ fontSize: 12 }}>{fullDate(a.modified)}</td>
                    <td><button className="secondary" disabled={busy} onClick={() => restore(a.name)}>Restore</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {archives?.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No vault backups at the destination yet.</div>}
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            …or from a downloaded <code>.enc</code> file (e.g. on a fresh BaumLab):{' '}
            <input type="file" accept=".enc,application/json" disabled={busy} onChange={e => importFile(e.target.files[0])} />
          </label>
        </div>
      </details>
    </div>
  )
}

function KitForm({ api, initial, destinations, services, onSaved, onCancel, notify }) {
  const editing = initial?.id != null
  const [form, setForm] = useState({ ...blankKit, destination_id: destinations[0]?.id ?? '', ...initial })
  const [sources, setSources] = useState([])
  const [groups, setGroups] = useState(null)
  const [loading, setLoading] = useState(false)
  const set = patch => setForm(f => ({ ...f, ...patch }))

  useEffect(() => {
    apiJson(api, `${API}/kits/sources`).then(list => {
      setSources(list)
      if (!form.connection && list.length) {
        const first = list.find(s => s.endpoints.length) || list[0]
        set({ connection: first.connection, endpoint_id: first.endpoints[0]?.id ?? '', endpoint_name: first.endpoints[0]?.name ?? '' })
      }
    }).catch(e => notify({ ok: false, text: e.message }))
  }, [])

  useEffect(() => {
    if (!form.connection || form.endpoint_id === '') return
    setLoading(true); setGroups(null)
    apiJson(api, `${API}/kits/discover?connection=${encodeURIComponent(form.connection)}&endpoint_id=${form.endpoint_id}`)
      .then(setGroups).catch(e => notify({ ok: false, text: e.message })).finally(() => setLoading(false))
  }, [form.connection, form.endpoint_id])

  const endpoints = sources.find(s => s.connection === form.connection)?.endpoints ?? []
  const groupKey = g => g.project ? `p:${g.project}` : `c:${g.containers[0]}`
  const current = groups?.find(g => form.project ? g.project === form.project : !g.project && g.containers[0] === form.containers[0])

  function pick(key) {
    const g = groups.find(x => groupKey(x) === key)
    if (!g) return
    set({ project: g.project, containers: g.project ? [] : g.containers, exclude_mounts: [], name: editing ? form.name : g.name })
  }

  async function save(e) {
    e.preventDefault()
    const body = { ...form, endpoint_id: +form.endpoint_id, destination_id: +form.destination_id,
                   retention_days: +form.retention_days, schedule_cron: form.schedule_cron || null }
    try {
      onSaved(await apiJson(api, editing ? `${API}/kits/${initial.id}` : `${API}/kits`,
                            { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }))
    } catch (err) { notify({ ok: false, text: err.message }) }
  }

  if (destinations.length === 0) return <div className="card" style={{ color: 'var(--text-muted)' }}>Add a destination first (Destinations tab).</div>
  if (sources.length === 0) return <div className="card" style={{ color: 'var(--text-muted)' }}>Add a Portainer connection first (Docker page).</div>

  return (
    <form className="card" onSubmit={save}>
      <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>{editing ? `Edit ${initial.name}` : 'New recovery kit'}</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Everything needed to rebuild one service from nothing: its compose definition, environment (encrypted with the
        recovery passphrase), every volume and folder it mounts, live database dumps, and a RESTORE.md — collected
        through Portainer from whichever host it runs on.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <div>
          <Field label="Portainer connection">
            <select value={form.connection} onChange={e => {
              const s = sources.find(x => x.connection === e.target.value)
              set({ connection: e.target.value, endpoint_id: s?.endpoints[0]?.id ?? '', endpoint_name: s?.endpoints[0]?.name ?? '', project: null, containers: [] })
            }}>
              {sources.map(s => <option key={s.connection} value={s.connection}>{s.connection}</option>)}
            </select>
          </Field>
          <Field label="Environment (host)">
            <select value={form.endpoint_id} onChange={e => {
              const ep = endpoints.find(x => String(x.id) === e.target.value)
              set({ endpoint_id: e.target.value, endpoint_name: ep?.name ?? '', project: null, containers: [] })
            }}>
              {endpoints.length === 0 && <option value="">— no environments seen yet —</option>}
              {endpoints.map(ep => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
            </select>
          </Field>
          <Field label="Service" hint="a compose stack, or a single container">
            <select required value={current ? groupKey(current) : ''} onChange={e => pick(e.target.value)} disabled={!groups}>
              <option value="">{loading ? 'Looking…' : '— choose —'}</option>
              {(groups ?? []).map(g => (
                <option key={groupKey(g)} value={groupKey(g)}>
                  {g.project ? `${g.name} (stack, ${g.containers.length} containers${g.portainer_stack ? '' : ', not in Portainer'})` : `${g.name} (container)`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name"><input required value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
        </div>

        <div>
          <Field label="Data to include" hint="untick large media you back up elsewhere">
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {!current && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Choose a service first</span>}
              {current && current.mounts.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No volumes or folders mounted</span>}
              {current?.mounts.map(m => (
                <label key={m.key} style={{ display: 'flex', gap: 6, fontSize: 12, alignItems: 'flex-start', marginBottom: 4 }}>
                  <input type="checkbox" checked={!form.exclude_mounts.includes(m.key)}
                    onChange={e => set({ exclude_mounts: e.target.checked ? form.exclude_mounts.filter(k => k !== m.key) : [...form.exclude_mounts, m.key] })} />
                  <span>
                    <code>{m.source}</code> <span className="badge badge-gray">{m.type}</span>
                    <div style={{ color: 'var(--text-muted)' }}>→ {m.container}:{m.destination}</div>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {current?.databases.length > 0 && (
            <label style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={form.dump_databases} onChange={e => set({ dump_databases: e.target.checked })} />
              <span>Dump databases live: {current.databases.map(db => `${db.container} (${db.type})`).join(', ')}</span>
            </label>
          )}
          <label style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={form.stop_during_backup} onChange={e => set({ stop_during_backup: e.target.checked })} />
            <span>Stop the service while its files are copied <span style={{ color: 'var(--text-muted)' }}>(brief downtime; databases are dumped first either way)</span></span>
          </label>
          {!form.stop_during_backup && (
            <label style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={form.cold_copy_fallback} onChange={e => set({ cold_copy_fallback: e.target.checked })} />
              <span>If a database dump fails, stop the service and copy its files cold instead <span style={{ color: 'var(--text-muted)' }}>(started again and checked afterwards)</span></span>
            </label>
          )}
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
          <Field label="Keep kits for (days)">
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
        <button type="submit">{editing ? 'Save' : 'Create recovery kit'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function RestoreForm({ api, kit, archive, sources, onDone, onCancel }) {
  const [form, setForm] = useState({
    connection: kit.connection, endpoint_id: kit.endpoint_id,
    stack_name: (kit.project || kit.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, ''),
    restore_data: true, deploy: true, import_databases: false, replace_existing: false, passphrase: '',
  })
  const [error, setError] = useState('')
  const set = patch => setForm(f => ({ ...f, ...patch }))
  const endpoints = sources.find(s => s.connection === form.connection)?.endpoints ?? []
  const sameHost = form.connection === kit.connection && +form.endpoint_id === kit.endpoint_id

  async function submit(e) {
    e.preventDefault()
    const what = [form.restore_data && 'copy the data back', form.deploy && `deploy stack "${form.stack_name}"`,
                  form.import_databases && 'import the database dumps'].filter(Boolean).join(', ')
    if (!confirm(`Restore ${archive} — ${what}${form.replace_existing ? ' — and OVERWRITE existing volumes/folders' : ''}?`)) return
    try {
      await apiJson(api, `${API}/kits/${kit.id}/restore`, { method: 'POST', body: JSON.stringify({
        ...form, filename: archive, endpoint_id: +form.endpoint_id, passphrase: form.passphrase || null }) })
      onDone()
    } catch (err) { setError(err.message) }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <b style={{ fontSize: 13, color: 'var(--text)' }}>Restore {archive}</b>
      {error && <div style={{ color: 'var(--red)', fontSize: 12, margin: '6px 0' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        <Field label="To connection">
          <select value={form.connection} onChange={e => {
            const s = sources.find(x => x.connection === e.target.value)
            set({ connection: e.target.value, endpoint_id: s?.endpoints[0]?.id ?? '' })
          }}>
            {sources.map(s => <option key={s.connection} value={s.connection}>{s.connection}</option>)}
          </select>
        </Field>
        <Field label="Environment">
          <select value={form.endpoint_id} onChange={e => set({ endpoint_id: e.target.value })}>
            {endpoints.map(ep => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
          </select>
        </Field>
        <Field label="Stack name" hint="lowercase">
          <input required value={form.stack_name} onChange={e => set({ stack_name: e.target.value })} style={{ width: 180 }} />
        </Field>
      </div>
      {[['restore_data', 'Recreate volumes and folders, and copy the data back'],
        ['deploy', 'Deploy the stack in Portainer with its saved environment'],
        ['import_databases', 'Import the database dumps after deploying (only for an empty database — not needed when the data is copied back)'],
        ['replace_existing', 'Replace existing data — overwrite volumes / folders that already exist on that host']].map(([k, label]) => (
        <label key={k} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 6, color: k === 'replace_existing' && form[k] ? 'var(--red)' : undefined }}>
          <input type="checkbox" checked={form[k]} onChange={e => set({ [k]: e.target.checked })} /> {label}
        </label>
      ))}
      {sameHost && form.deploy && (
        <div style={{ fontSize: 12, color: 'var(--yellow)', marginBottom: 6 }}>
          Same host as the original: remove the existing stack first, or use another stack name (fixed container names
          or ports in the compose file may still clash).
        </div>
      )}
      <Field label="Passphrase" hint="only if this kit was made before the passphrase was changed">
        <input type="password" value={form.passphrase} onChange={e => set({ passphrase: e.target.value })} style={{ width: 260 }}
          autoComplete="off" />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" style={{ background: 'var(--red)' }}>Restore</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function KitArchives({ api, kit, onClose, notify }) {
  const [archives, setArchives] = useState(null)
  const [sources, setSources] = useState([])
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState(null)

  useEffect(() => {
    apiJson(api, `${API}/kits/${kit.id}/archives`).then(setArchives).catch(e => setError(e.message))
    apiJson(api, `${API}/kits/sources`).then(setSources).catch(() => {})
  }, [])

  return (
    <Modal title={`${kit.name} — kits`} onClose={onClose} width={860}>
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {!archives && !error && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Listing…</div>}
      {archives?.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No kits yet — press ▶ Back up.</div>}
      {archives?.length > 0 && (
        <table>
          <thead><tr><th>Kit</th><th>Size</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {archives.map(a => (
              <tr key={a.name} style={restoring === a.name ? { background: 'var(--bg2)' } : {}}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.name}</td>
                <td>{fmtBytes(a.size)}</td>
                <td style={{ fontSize: 12 }}>{fullDate(a.modified)}</td>
                <td><button className="secondary" onClick={() => setRestoring(a.name)}>Restore…</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restoring && (
        <RestoreForm api={api} kit={kit} archive={restoring} sources={sources} onCancel={() => setRestoring(null)}
          onDone={() => { notify({ ok: true, text: `Restore of ${kit.name} started — follow it in History` }); onClose() }} />
      )}
    </Modal>
  )
}

export default function Kits({ api, destinations, services, notify, openRun }) {
  const [kits, setKits] = useState([])
  const [passphrase, setPassphrase] = useState(null)
  const [editing, setEditing] = useState(null)
  const [browsing, setBrowsing] = useState(null)

  async function load() {
    try { setKits(await apiJson(api, `${API}/kits`)) } catch (e) { notify({ ok: false, text: e.message }) }
  }
  useEffect(() => {
    load()
    apiJson(api, `${API}/passphrase`).then(setPassphrase).catch(() => {})
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  async function runNow(k) {
    try {
      await apiJson(api, `${API}/kits/${k.id}/run`, { method: 'POST' })
      notify({ ok: true, text: `Building recovery kit for ${k.name}` })
      setTimeout(load, 1500)
    } catch (e) { notify({ ok: false, text: e.message }) }
  }

  async function verify(k) {
    try {
      await apiJson(api, `${API}/kits/${k.id}/verify`, { method: 'POST' })
      notify({ ok: true, text: `Verifying the newest kit of ${k.name} — result in History` })
      setTimeout(load, 1500)
    } catch (e) { notify({ ok: false, text: e.message }) }
  }

  async function remove(k) {
    if (!confirm(`Delete recovery kit ${k.name}? Kits already uploaded are kept.`)) return
    await apiJson(api, `${API}/kits/${k.id}`, { method: 'DELETE' }).catch(e => notify({ ok: false, text: e.message }))
    load()
  }

  return (
    <div>
      {passphrase && <PassphraseCard api={api} status={passphrase} onChange={setPassphrase} notify={notify} />}
      <VaultBackupCard api={api} destinations={destinations} passphraseSet={!!passphrase?.set} notify={notify} openRun={openRun} />
      {editing ? (
        <KitForm api={api} initial={editing} destinations={destinations} services={services} notify={notify}
          onCancel={() => setEditing(null)}
          onSaved={k => { setEditing(null); notify({ ok: true, text: `Saved ${k.name}` }); load() }} />
      ) : (
        <div className="toolbar"><button onClick={() => setEditing({})}>+ New recovery kit</button></div>
      )}
      {kits.length === 0 && !editing && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          No recovery kits yet. A kit captures one Docker service completely — compose file, environment, data and
          databases — so it can be rebuilt on any host.
        </div>
      )}
      {kits.length > 0 && (
        <table>
          <thead><tr><th>Status</th><th>Service</th><th>Host</th><th>Schedule</th><th>Last success</th><th>Verified</th><th></th></tr></thead>
          <tbody>
            {kits.map(k => (
              <tr key={k.id}>
                <td>{k.running ? <StatusBadge status="running" /> : <StatusBadge status={k.freshness} />}</td>
                <td>
                  <div style={{ fontWeight: 500 }}>{k.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {k.project ? `stack ${k.project}` : k.containers.join(', ')}
                    {k.exclude_mounts.length > 0 && ` · ${k.exclude_mounts.length} mount(s) excluded`}
                  </div>
                </td>
                <td style={{ fontSize: 12 }}>{k.endpoint_name || k.endpoint_id}<div style={{ color: 'var(--text-muted)' }}>{k.connection}</div></td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{k.schedule_cron || 'manual'}</td>
                <td style={{ fontSize: 12 }} title={fullDate(k.last_success_at)}>{ago(k.last_success_at)}</td>
                <td style={{ fontSize: 12 }} title={k.last_verify_message || 'Not verified yet — runs every Sunday, or press Verify'}>
                  {k.last_verify_status
                    ? <span className={`badge badge-${k.last_verify_status === 'success' ? 'green' : 'red'}`}>{k.last_verify_status === 'success' ? '✓' : '✗'} {ago(k.last_verified_at)}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>never</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="secondary" disabled={k.running || !passphrase?.set} onClick={() => runNow(k)}>▶ Back up</button>
                    <button className="secondary" onClick={() => setBrowsing(k)}>Kits</button>
                    <button className="secondary" disabled={k.running || !k.last_success_at} onClick={() => verify(k)}
                      title="Download the newest kit and check every copy, dump and the passphrase">Verify</button>
                    <button className="secondary" onClick={() => openRun({ kind: 'kit', id: k.id })}>History</button>
                    <button className="secondary" onClick={() => setEditing(k)}>✎</button>
                    <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(k)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {browsing && <KitArchives api={api} kit={browsing} notify={notify} onClose={() => { setBrowsing(null); load() }} />}
    </div>
  )
}

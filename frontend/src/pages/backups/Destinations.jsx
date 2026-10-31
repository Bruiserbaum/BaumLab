import React, { useEffect, useState } from 'react'
import { API, Field, apiJson } from './common'

const MASK = '••••••••'

// type → [field, label, hint?, secret?]
const FIELDS = {
  b2: [['account_id', 'Key ID'], ['application_key', 'Application key', '', true], ['path', 'Bucket / folder', 'e.g. my-bucket/baumlab']],
  smb: [['host', 'Host'], ['share', 'Share'], ['path', 'Folder in share'], ['user', 'User'], ['password', 'Password', '', true], ['domain', 'Domain', 'blank = WORKGROUP']],
  sftp: [['host', 'Host'], ['port', 'Port'], ['user', 'User'], ['password', 'Password', 'or use a key file', true], ['key_file', 'Key file path', 'inside the container'], ['path', 'Folder']],
  local: [['path', 'Folder', 'a path inside the BaumLab container — mount it in docker-compose']],
}
const TYPE_LABELS = { b2: 'Backblaze B2', smb: 'SMB / NAS share', sftp: 'SFTP', local: 'Local folder' }
// Which field holds the secret / login per type — can come from a vault entry instead
const SECRET_BY_TYPE = { b2: 'application_key', smb: 'password', sftp: 'password' }
const USER_BY_TYPE = { b2: 'account_id', smb: 'user', sftp: 'user' }

function DestinationForm({ api, initial, onSaved, onCancel, notify }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState(initial?.type ?? 'b2')
  const [config, setConfig] = useState(initial?.config ?? { port: 22 })
  const editing = initial?.id != null
  const [entries, setEntries] = useState(null)
  const [vaultError, setVaultError] = useState('')
  const fromVault = config.credential_id != null && config.credential_id !== ''

  useEffect(() => {
    apiJson(api, '/api/vault/').then(setEntries).catch(e => { setEntries([]); setVaultError(e.message) })
  }, [])

  async function save(e) {
    e.preventDefault()
    try {
      const saved = await apiJson(api, editing ? `${API}/destinations/${initial.id}` : `${API}/destinations`, {
        method: editing ? 'PUT' : 'POST', body: JSON.stringify({ name, type, config }),
      })
      onSaved(saved)
    } catch (err) { notify({ ok: false, text: err.message }) }
  }

  return (
    <form className="card" onSubmit={save} style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0, fontSize: 15, color: 'var(--text)' }}>{editing ? `Edit ${initial.name}` : 'New destination'}</h2>
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Name" style={{ flex: 1 }}><input required value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Type">
          <select value={type} onChange={e => setType(e.target.value)} disabled={editing}>
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      {SECRET_BY_TYPE[type] && (
        <Field label="Credentials" hint={vaultError ? 'vault unavailable' : 'keep the password / key in the BaumLab vault'}>
          <select value={config.credential_id ?? ''} onChange={e => setConfig(c => ({ ...c, credential_id: e.target.value === '' ? null : +e.target.value }))}>
            <option value="">Type them here (stored encrypted with this destination)</option>
            {(entries ?? []).map(v => <option key={v.id} value={v.id}>🔒 {v.title}{v.username ? ` (${v.username})` : ''}</option>)}
          </select>
          {vaultError && <span style={{ fontSize: 11, color: 'var(--yellow)' }}>{vaultError}</span>}
          {entries?.length === 0 && !vaultError && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No vault entries yet — add one on the Vault page, or save here and use “Move to vault”.</span>
          )}
        </Field>
      )}
      {FIELDS[type].filter(([key]) => !(fromVault && key === SECRET_BY_TYPE[type])).map(([key, label, hint, secret]) => (
        <Field key={key} label={label}
          hint={fromVault && key === USER_BY_TYPE[type] ? "blank = the vault entry's username" : secret && config[key] === MASK ? 'saved — blank keeps it' : hint}>
          <input type={secret ? 'password' : key === 'port' ? 'number' : 'text'} autoComplete={secret ? 'new-password' : 'off'}
            value={config[key] === MASK ? '' : config[key] ?? ''} placeholder={secret && config[key] === MASK ? MASK : ''}
            onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))} />
        </Field>
      ))}
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        {fromVault ? 'The password / key is read from the vault only while rclone runs, and each use is logged in the vault audit.'
                   : 'Credentials are stored encrypted and handed to rclone only while a backup runs.'}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit">{editing ? 'Save' : 'Add destination'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

export default function Destinations({ api, destinations, reload, notify }) {
  const [editing, setEditing] = useState(null)
  const [testing, setTesting] = useState({})

  async function test(d) {
    setTesting(t => ({ ...t, [d.id]: 'testing' }))
    try {
      const r = await apiJson(api, `${API}/destinations/${d.id}/test`, { method: 'POST' })
      setTesting(t => ({ ...t, [d.id]: r }))
    } catch (e) { setTesting(t => ({ ...t, [d.id]: { ok: false, message: e.message } })) }
  }

  async function toVault(d) {
    if (!confirm(`Move ${d.name}'s password / key into a new vault entry? The destination will read it from the vault from now on.`)) return
    try { await apiJson(api, `${API}/destinations/${d.id}/to-vault`, { method: 'POST' }); notify({ ok: true, text: `Moved ${d.name}'s credentials into the vault` }); reload() }
    catch (e) { notify({ ok: false, text: e.message }) }
  }

  async function remove(d) {
    if (!confirm(`Delete destination ${d.name}? Archives stored there are not touched.`)) return
    try { await apiJson(api, `${API}/destinations/${d.id}`, { method: 'DELETE' }); reload() }
    catch (e) { notify({ ok: false, text: e.message }) }
  }

  return (
    <div>
      {editing ? (
        <DestinationForm api={api} initial={editing} notify={notify} onCancel={() => setEditing(null)}
          onSaved={d => { setEditing(null); notify({ ok: true, text: `Saved ${d.name}` }); reload() }} />
      ) : (
        <div className="toolbar"><button onClick={() => setEditing({})}>+ New destination</button></div>
      )}
      {destinations.length === 0 && !editing && (
        <div className="card" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
          No destinations yet. Add Backblaze B2, a NAS share, SFTP or a local folder.
        </div>
      )}
      {destinations.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Location</th><th>Used by</th><th>Test</th><th></th></tr></thead>
          <tbody>
            {destinations.map(d => {
              const t = testing[d.id]
              return (
                <tr key={d.id}>
                  <td style={{ fontWeight: 500 }}>{d.name}</td>
                  <td>{TYPE_LABELS[d.type] ?? d.type}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {[d.config.host, d.config.share, d.config.path].filter(Boolean).join(' / ') || '—'}
                    {d.credential && <div style={{ fontFamily: 'inherit', color: 'var(--green)' }}>🔒 {d.credential.title}</div>}
                    {d.credential_missing && <div style={{ fontFamily: 'inherit', color: 'var(--red)' }}>⚠ linked vault entry was deleted — edit to fix</div>}
                  </td>
                  <td>{d.used_by}</td>
                  <td style={{ fontSize: 12, color: t?.ok ? 'var(--green)' : 'var(--red)', maxWidth: 260 }}>
                    {t === 'testing' ? <span style={{ color: 'var(--text-muted)' }}>Testing…</span> : t ? `${t.ok ? '✓' : '✗'} ${t.message}` : ''}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="secondary" onClick={() => test(d)}>Test</button>
                      {SECRET_BY_TYPE[d.type] && !d.config.credential_id && d.config[SECRET_BY_TYPE[d.type]] && (
                        <button className="secondary" onClick={() => toVault(d)} title="Move the stored password / key into the vault">🔒 Move to vault</button>
                      )}
                      <button className="secondary" onClick={() => setEditing(d)}>✎</button>
                      <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => remove(d)}>✕</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

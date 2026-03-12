import React, { useEffect, useState } from 'react'
import { useAuth, useApi } from '../auth'

const blank = { username: '', password: '', is_admin: false }

export default function UsersPage() {
  const { user: me, isAdmin } = useAuth()
  const api = useApi()
  const [users, setUsers]       = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm]         = useState(blank)
  const [editId, setEditId]     = useState(null)
  const [editData, setEditData] = useState({})
  const [error, setError]       = useState('')
  const [mfaPanel, setMfaPanel] = useState(null)  // user id with MFA panel open

  async function load() {
    const r = await api('/api/users/')
    if (r.ok) setUsers(await r.json())
  }

  useEffect(() => { load() }, [])

  async function createUser(e) {
    e.preventDefault()
    setError('')
    const r = await api('/api/users/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    if (!r.ok) { setError((await r.json()).detail); return }
    setForm(blank)
    setShowForm(false)
    await load()
  }

  async function saveEdit(id) {
    setError('')
    const r = await api(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editData),
    })
    if (!r.ok) { setError((await r.json()).detail); return }
    setEditId(null)
    await load()
  }

  async function deleteUser(id) {
    if (!confirm('Delete this user?')) return
    await api(`/api/users/${id}`, { method: 'DELETE' })
    await load()
  }

  // Non-admins can only see and edit themselves
  const visible = isAdmin ? users : users.filter(u => u.id === me?.id)

  return (
    <div>
      <h1>Users</h1>

      {isAdmin && (
        <div className="toolbar">
          <button onClick={() => setShowForm(s => !s)}>{showForm ? 'Cancel' : '+ Add User'}</button>
        </div>
      )}

      {showForm && isAdmin && (
        <form className="card" onSubmit={createUser}
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            Username
            <input required value={form.username} onChange={e => setForm(x => ({ ...x, username: e.target.value }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            Password
            <input required type="password" value={form.password} onChange={e => setForm(x => ({ ...x, password: e.target.value }))} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={form.is_admin} onChange={e => setForm(x => ({ ...x, is_admin: e.target.checked }))} />
            Admin
          </label>
          <button type="submit">Create</button>
        </form>
      )}

      {error && (
        <div style={{ margin: '8px 0', fontSize: 12, color: 'var(--red)', background: '#2e1a1a', border: '1px solid var(--red)', borderRadius: 6, padding: '8px 12px' }}>
          {error}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>2FA</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map(u => (
            <React.Fragment key={u.id}>
              <tr>
                <td>
                  {editId === u.id ? (
                    <input value={editData.username ?? u.username}
                      onChange={e => setEditData(x => ({ ...x, username: e.target.value }))} />
                  ) : (
                    <span>
                      {u.username}
                      {u.id === me?.id && <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>(you)</span>}
                    </span>
                  )}
                </td>
                <td>
                  {editId === u.id && isAdmin && u.id !== me?.id ? (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <input type="checkbox"
                        checked={editData.is_admin ?? u.is_admin}
                        onChange={e => setEditData(x => ({ ...x, is_admin: e.target.checked }))} />
                      Admin
                    </label>
                  ) : (
                    <span className={`badge badge-${u.is_admin ? 'green' : 'gray'}`}>
                      {u.is_admin ? 'admin' : 'user'}
                    </span>
                  )}
                </td>
                <td>
                  <span className={`badge badge-${u.totp_enabled ? 'green' : 'gray'}`}>
                    {u.totp_enabled ? 'enabled' : 'off'}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {editId === u.id ? (
                      <>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                          New password
                          <input type="password" placeholder="leave blank to keep"
                            onChange={e => setEditData(x => ({ ...x, password: e.target.value || undefined }))} />
                        </label>
                        <button onClick={() => saveEdit(u.id)} style={{ alignSelf: 'flex-end' }}>Save</button>
                        <button className="secondary" onClick={() => { setEditId(null); setError('') }} style={{ alignSelf: 'flex-end' }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        {(isAdmin || u.id === me?.id) && (
                          <button className="secondary" onClick={() => { setEditId(u.id); setEditData({}) }}>Edit</button>
                        )}
                        {u.id === me?.id && (
                          <button className="secondary"
                            onClick={() => setMfaPanel(mfaPanel === u.id ? null : u.id)}>
                            {u.totp_enabled ? 'Manage 2FA' : 'Enable 2FA'}
                          </button>
                        )}
                        {isAdmin && u.id !== me?.id && (
                          <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => deleteUser(u.id)}>Delete</button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>

              {/* ── MFA panel (spans full row) ── */}
              {mfaPanel === u.id && (
                <tr>
                  <td colSpan={5} style={{ padding: 0, border: 'none' }}>
                    <MfaPanel
                      user={u}
                      api={api}
                      onDone={() => { setMfaPanel(null); load() }}
                    />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── MFA inline panel ──────────────────────────────────────────────────────────

function MfaPanel({ user, api, onDone }) {
  const [setup, setSetup]       = useState(null)
  const [code, setCode]         = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState('')
  const mode = user.totp_enabled ? 'disable' : 'setup'

  useEffect(() => {
    if (mode === 'setup') {
      setLoading(true)
      api('/api/auth/mfa/setup').then(r => r.ok ? r.json() : null).then(data => {
        if (data) setSetup(data)
        else setError('Failed to generate setup code')
        setLoading(false)
      })
    }
  }, [])

  async function handleEnable(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const r = await api('/api/auth/mfa/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: setup.secret, code }),
    })
    if (r.ok) {
      setSuccess('Two-factor authentication enabled.')
      setTimeout(onDone, 1200)
    } else {
      setError((await r.json()).detail)
      setCode('')
    }
    setLoading(false)
  }

  async function handleDisable(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const r = await api('/api/auth/mfa/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (r.ok) {
      setSuccess('Two-factor authentication disabled.')
      setTimeout(onDone, 1200)
    } else {
      setError((await r.json()).detail)
      setPassword('')
    }
    setLoading(false)
  }

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderTop: 'none', borderRadius: '0 0 6px 6px',
      padding: '18px 24px', marginBottom: 6,
    }}>

      {/* ── Setup mode ── */}
      {mode === 'setup' && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Set up two-factor authentication</div>
          {loading && !setup && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Generating QR code…</div>}
          {setup && (
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <img src={setup.qr} alt="QR code"
                style={{ width: 176, height: 176, background: '#fff', borderRadius: 6, padding: 4, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                  1. Open Google Authenticator (or any TOTP app) and scan this QR code.<br />
                  2. Enter the 6-digit code below to confirm.
                </p>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
                  Manual entry key:&nbsp;
                  <span style={{ fontFamily: 'monospace', color: 'var(--text)', letterSpacing: '0.08em' }}>
                    {setup.secret}
                  </span>
                </div>
                <form onSubmit={handleEnable}
                  style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                    Confirmation code
                    <input
                      value={code}
                      onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      placeholder="000000"
                      maxLength={6}
                      required
                      autoFocus
                      style={{ width: 120, letterSpacing: '0.25em', fontFamily: 'monospace', textAlign: 'center' }}
                    />
                  </label>
                  <button type="submit" disabled={loading || code.length !== 6}>
                    {loading ? 'Enabling…' : 'Enable 2FA'}
                  </button>
                </form>
                {error   && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>✗ {error}</div>}
                {success && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--green)' }}>✓ {success}</div>}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Disable mode ── */}
      {mode === 'disable' && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Disable two-factor authentication</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px' }}>
            Confirm your password to remove 2FA from your account.
          </p>
          <form onSubmit={handleDisable}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              Current password
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoFocus
                style={{ width: 200 }}
              />
            </label>
            <button type="submit" disabled={loading || !password} style={{ color: 'var(--red)' }}>
              {loading ? 'Disabling…' : 'Disable 2FA'}
            </button>
          </form>
          {error   && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>✗ {error}</div>}
          {success && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--green)' }}>✓ {success}</div>}
        </>
      )}
    </div>
  )
}

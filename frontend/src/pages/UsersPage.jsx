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

  async function load() {
    const r = await api('/api/users/')
    if (r.ok) setUsers(await r.json())
  }

  useEffect(() => { if (isAdmin) load() }, [isAdmin])

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
        <form className="card" onSubmit={createUser} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map(u => (
            <tr key={u.id}>
              <td>
                {editId === u.id ? (
                  <input value={editData.username ?? u.username}
                    onChange={e => setEditData(x => ({ ...x, username: e.target.value }))} />
                ) : (
                  <span>{u.username} {u.id === me?.id && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>(you)</span>}</span>
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
                      {isAdmin && u.id !== me?.id && (
                        <button className="secondary" style={{ color: 'var(--red)' }} onClick={() => deleteUser(u.id)}>Delete</button>
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

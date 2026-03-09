import React, { useState } from 'react'
import { useAuth } from '../auth'

export default function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--bg)',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 36, width: 320, display: 'flex',
        flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>
          BaumLab
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
          Sign in to continue
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          Username
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            required
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </label>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--red)', background: '#2e1a1a', border: '1px solid var(--red)', borderRadius: 6, padding: '8px 12px' }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} style={{ marginTop: 4 }}>
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  )
}

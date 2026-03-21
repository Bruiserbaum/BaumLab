import React, { useState, useRef, useEffect } from 'react'
import { useAuth } from '../auth'

export default function LoginPage() {
  const { login, completeMfaLogin } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep]         = useState('password')   // 'password' | 'totp'
  const [mfaToken, setMfaToken] = useState('')
  const [code, setCode]         = useState('')
  const [loading, setLoading]   = useState(false)
  const codeRef = useRef(null)

  // Read ?oidc_error= from URL (set by /api/auth/oidc/callback on failure)
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const e = params.get('oidc_error')
    if (e) window.history.replaceState({}, '', '/')
    return e ? `SSO login failed: ${e.replace(/_/g, ' ')}` : ''
  })

  // Fetch OIDC config to decide whether to show the SSO button
  const [oidcEnabled, setOidcEnabled] = useState(false)
  useEffect(() => {
    fetch('/api/auth/config')
      .then(r => r.json())
      .then(d => setOidcEnabled(!!d.oidc_enabled))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (step === 'totp') codeRef.current?.focus()
  }, [step])

  async function handlePassword(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await login(username, password)
      if (result.mfa_required) {
        setMfaToken(result.mfa_token)
        setStep('totp')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleTotp(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await completeMfaLogin(mfaToken, code)
    } catch (err) {
      setError(err.message)
      setCode('')
    } finally {
      setLoading(false)
    }
  }

  const cardStyle = {
    background: 'var(--bg2)', border: '1px solid var(--border)',
    borderRadius: 10, padding: 36, width: 320, display: 'flex',
    flexDirection: 'column', gap: 16,
  }
  const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-muted)' }
  const errStyle   = { fontSize: 12, color: 'var(--red)', background: '#2e1a1a', border: '1px solid var(--red)', borderRadius: 6, padding: '8px 12px' }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>

      {step === 'password' && (
        <form onSubmit={handlePassword} style={cardStyle}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>BaumLab</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>Sign in to continue</div>

          <label style={fieldStyle}>
            Username
            <input value={username} onChange={e => setUsername(e.target.value)} autoFocus required />
          </label>
          <label style={fieldStyle}>
            Password
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
          </label>

          {error && <div style={errStyle}>{error}</div>}
          <button type="submit" disabled={loading} style={{ marginTop: 4 }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>

          {oidcEnabled && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>or</span>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              <a href="/api/auth/oidc/login" style={{ textDecoration: 'none' }}>
                <button type="button" className="secondary" style={{ width: '100%' }}>
                  Login with Authentik
                </button>
              </a>
            </>
          )}
        </form>
      )}

      {step === 'totp' && (
        <form onSubmit={handleTotp} style={cardStyle}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>BaumLab</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Two-factor authentication</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            Enter the 6-digit code from your authenticator app.
          </div>

          <label style={fieldStyle}>
            Authentication code
            <input
              ref={codeRef}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="000000"
              maxLength={6}
              required
              style={{ letterSpacing: '0.35em', fontSize: 22, textAlign: 'center', fontFamily: 'monospace' }}
            />
          </label>

          {error && <div style={errStyle}>{error}</div>}
          <button type="submit" disabled={loading || code.length !== 6} style={{ marginTop: 4 }}>
            {loading ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" className="secondary"
            onClick={() => { setStep('password'); setError(''); setCode('') }}>
            ← Back
          </button>
        </form>
      )}
    </div>
  )
}

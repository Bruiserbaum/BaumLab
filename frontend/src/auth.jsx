import React, { createContext, useContext, useState, useCallback } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('bl_token'))
  const [user, setUser]   = useState(() => {
    try { return JSON.parse(localStorage.getItem('bl_user')) } catch { return null }
  })

  async function _finalize(access_token) {
    const meRes = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${access_token}` } })
    const me = await meRes.json()
    localStorage.setItem('bl_token', access_token)
    localStorage.setItem('bl_user', JSON.stringify(me))
    setToken(access_token)
    setUser(me)
  }

  // Returns { mfa_required: true, mfa_token } if TOTP is needed, otherwise resolves fully.
  const login = useCallback(async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password: password.trim() }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Login failed (${res.status})`)
    }
    const data = await res.json()
    if (data.mfa_required) {
      return { mfa_required: true, mfa_token: data.mfa_token }
    }
    await _finalize(data.access_token)
    return { mfa_required: false }
  }, [])

  // Called from the TOTP step of the login page.
  const completeMfaLogin = useCallback(async (mfa_token, code) => {
    const res = await fetch('/api/auth/login/mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfa_token, code: code.trim() }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Authentication failed (${res.status})`)
    }
    const { access_token } = await res.json()
    await _finalize(access_token)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('bl_token')
    localStorage.removeItem('bl_user')
    setToken(null)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ token, user, login, completeMfaLogin, logout, isAdmin: user?.is_admin ?? false }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() { return useContext(AuthContext) }

/** Fetch wrapper that injects the Bearer token and handles 401 globally. */
export function useApi() {
  const { token, logout } = useAuth()
  return useCallback(async (url, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) { logout(); return res }
    return res
  }, [token, logout])
}

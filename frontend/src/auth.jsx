import React, { createContext, useContext, useState, useCallback } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('bl_token'))
  const [user, setUser]   = useState(() => {
    try { return JSON.parse(localStorage.getItem('bl_user')) } catch { return null }
  })

  const login = useCallback(async (username, password) => {
    const form = new URLSearchParams({ username, password })
    const res = await fetch('/api/auth/login', { method: 'POST', body: form })
    if (!res.ok) throw new Error('Invalid username or password')
    const { access_token } = await res.json()

    const meRes = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${access_token}` } })
    const me = await meRes.json()

    localStorage.setItem('bl_token', access_token)
    localStorage.setItem('bl_user', JSON.stringify(me))
    setToken(access_token)
    setUser(me)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('bl_token')
    localStorage.removeItem('bl_user')
    setToken(null)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAdmin: user?.is_admin ?? false }}>
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

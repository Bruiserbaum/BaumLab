import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import LoginPage from './pages/LoginPage'
import DevicesPage from './pages/DevicesPage'
import MonitorsPage from './pages/MonitorsPage'
import NetworkMapPage from './pages/NetworkMapPage'
import UsersPage from './pages/UsersPage'
import SettingsPage from './pages/SettingsPage'
import ExternalScanPage from './pages/ExternalScanPage'
import './styles.css'

function App() {
  const { token, user, logout, isAdmin } = useAuth()

  if (!token) return <LoginPage />

  return (
    <BrowserRouter>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">BaumLab</div>
          <NavLink to="/" end>Network Map</NavLink>
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/monitors">Monitors</NavLink>
          <NavLink to="/external-scan">External Scan</NavLink>
          <NavLink to="/users">Users</NavLink>
          {isAdmin && <NavLink to="/settings">Settings</NavLink>}
          <div style={{ marginTop: 'auto', padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              {user?.username}
              {isAdmin && <span style={{ marginLeft: 6, color: 'var(--green)', fontSize: 10 }}>ADMIN</span>}
            </div>
            <button className="secondary" style={{ width: '100%', fontSize: 12 }} onClick={logout}>
              Sign Out
            </button>
          </div>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<NetworkMapPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/monitors" element={<MonitorsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/external-scan" element={<ExternalScanPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthProvider><App /></AuthProvider>
)

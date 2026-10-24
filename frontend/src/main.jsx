import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import LoginPage from './pages/LoginPage'
import DevicesPage from './pages/DevicesPage'
import MonitorsPage from './pages/MonitorsPage'
import ServicesPage from './pages/ServicesPage'
import VaultPage from './pages/VaultPage'
import ToolsPage from './pages/ToolsPage'
import ReposPage from './pages/ReposPage'
import BackupsPage from './pages/backups/BackupsPage'
import NetworkMapPage from './pages/NetworkMapPage'
import UsersPage from './pages/UsersPage'
import SettingsPage from './pages/SettingsPage'
import ExternalScanPage from './pages/ExternalScanPage'
import StatusPage from './pages/StatusPage'
import TargetScanPage from './pages/TargetScanPage'
import UniFiPage from './pages/UniFiPage'
import VulnScanPage from './pages/VulnScanPage'
import SyslogPage from './pages/SyslogPage'
import PortainerPage from './pages/PortainerPage'
import './styles.css'

function App() {
  const { token, user, logout, isAdmin, authChecking } = useAuth()
  const [appVersion, setAppVersion] = useState('')
  const [newVersion, setNewVersion] = useState('')

  useEffect(() => {
    fetch('/api/auth/version').then(r => r.ok ? r.json() : null).then(d => { if (d) setAppVersion(d.version) })
  }, [])

  useEffect(() => {
    if (!token || !isAdmin) return
    fetch('/api/updates/status', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => setNewVersion(d?.update_available ? d.latest : ''))
      .catch(() => {})
  }, [token, isAdmin])

  // Public route — no login required
  if (window.location.pathname === '/status') return <StatusPage />

  // Wait for silent auth checks (OIDC callback / header auth) before deciding to show login
  if (authChecking) return null

  if (!token) return <LoginPage />

  return (
    <BrowserRouter>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">BaumLab</div>
          <div className="nav-section">Network</div>
          <NavLink to="/" end>Network Map</NavLink>
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/unifi">UniFi</NavLink>
          <NavLink to="/syslog">Syslog</NavLink>

          <div className="nav-section">Services</div>
          <NavLink to="/services">Services</NavLink>
          {isAdmin && <NavLink to="/vault">Vault</NavLink>}
          <NavLink to="/monitors">Monitors</NavLink>
          <NavLink to="/portainer">Docker</NavLink>
          {isAdmin && <NavLink to="/backups">Backups</NavLink>}

          <div className="nav-section">Security</div>
          <NavLink to="/external-scan">External Scan</NavLink>
          <NavLink to="/target-scan">Target Scan</NavLink>
          <NavLink to="/vuln-scan">Vuln Scan</NavLink>

          <div className="nav-section">Tools</div>
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/repos">Repositories</NavLink>

          <div className="nav-section" style={{ marginTop: 'auto' }}>Admin</div>
          <NavLink to="/users">Users</NavLink>
          {isAdmin && <NavLink to="/settings">Settings</NavLink>}
          <div style={{ marginTop: 8, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              {user?.username}
              {isAdmin && <span style={{ marginLeft: 6, color: 'var(--green)', fontSize: 10 }}>ADMIN</span>}
            </div>
            <button className="secondary" style={{ width: '100%', fontSize: 12 }} onClick={logout}>
              Sign Out
            </button>
            {appVersion && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, textAlign: 'center', opacity: 0.6 }}>
                v{appVersion}
              </div>
            )}
            {newVersion && (
              <NavLink to="/settings" style={{ fontSize: 11, textAlign: 'center', margin: '4px 0 0', padding: 4,
                color: 'var(--yellow)' }}>
                ↑ v{newVersion} available
              </NavLink>
            )}
          </div>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<NetworkMapPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/services" element={<ServicesPage />} />
            <Route path="/vault" element={<VaultPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/repos" element={<ReposPage />} />
            <Route path="/backups" element={<BackupsPage />} />
            <Route path="/monitors" element={<MonitorsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/external-scan" element={<ExternalScanPage />} />
            <Route path="/target-scan" element={<TargetScanPage />} />
            <Route path="/unifi" element={<UniFiPage />} />
            <Route path="/vuln-scan" element={<VulnScanPage />} />
            <Route path="/syslog" element={<SyslogPage />} />
            <Route path="/portainer" element={<PortainerPage />} />
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

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
import AlertsPage from './pages/AlertsPage'
import DashboardPage from './pages/DashboardPage'
import CertificatesPage from './pages/CertificatesPage'
import LaunchpadPage from './pages/LaunchpadPage'
import HomePage from './pages/HomePage'
import TerminalPage from './pages/TerminalPage'
import HealthPage from './pages/HealthPage'
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
  const [apiBuilt, setApiBuilt] = useState(null)
  const [staleUi, setStaleUi] = useState(false)
  const [newVersion, setNewVersion] = useState('')

  useEffect(() => {
    fetch('/api/auth/version').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return
      setAppVersion(d.version)
      setApiBuilt(d.built)
      // Both images build within minutes of each other on a redeploy; a much older page means a cached bundle
      if (d.built && new Date(d.built) - new Date(__UI_BUILT__) > 30 * 60 * 1000) setStaleUi(true)
    })
  }, [])

  useEffect(() => {
    if (!token || !isAdmin) return
    fetch('/api/updates/status', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => setNewVersion(d?.update_available ? d.latest : ''))
      .catch(() => {})
  }, [token, isAdmin])

  // Public routes — no login required
  if (window.location.pathname === '/status') return <StatusPage />
  // Home page decides for itself: full Launchpad when signed in, public tiles otherwise
  if (window.location.pathname === '/home') return <HomePage />

  // Wait for silent auth checks (OIDC callback / header auth) before deciding to show login
  if (authChecking) return null

  if (!token) return <LoginPage />

  return (
    <BrowserRouter>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">BaumLab</div>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/launchpad">Launchpad</NavLink>

          <div className="nav-section">Network</div>
          <NavLink to="/map">Network Map</NavLink>
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
          <NavLink to="/certificates">Certificates</NavLink>

          <div className="nav-section">Tools</div>
          {isAdmin && <NavLink to="/terminal">Terminal</NavLink>}
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/repos">Repositories</NavLink>

          <div className="nav-section" style={{ marginTop: 'auto' }}>Admin</div>
          {isAdmin && <NavLink to="/health">Health</NavLink>}
          {isAdmin && <NavLink to="/alerts">Alerts</NavLink>}
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
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, textAlign: 'center', opacity: 0.6 }}
                title={`API built ${apiBuilt ? new Date(apiBuilt).toLocaleString() : 'unknown'}\nPage built ${new Date(__UI_BUILT__).toLocaleString()}`}>
                v{appVersion}{apiBuilt && ` · ${new Date(apiBuilt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${new Date(apiBuilt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}
              </div>
            )}
            {staleUi && (
              <a href="#" onClick={e => { e.preventDefault(); window.location.reload() }}
                style={{ display: 'block', fontSize: 11, textAlign: 'center', marginTop: 4, color: 'var(--yellow)' }}>
                ↻ New build deployed — reload
              </a>
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
            <Route path="/" element={<DashboardPage />} />
            <Route path="/map" element={<NetworkMapPage />} />
            <Route path="/launchpad" element={<LaunchpadPage />} />
            <Route path="/certificates" element={<CertificatesPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/services" element={<ServicesPage />} />
            <Route path="/vault" element={<VaultPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/repos" element={<ReposPage />} />
            <Route path="/backups" element={<BackupsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
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

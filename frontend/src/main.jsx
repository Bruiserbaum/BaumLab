import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import DevicesPage from './pages/DevicesPage'
import MonitorsPage from './pages/MonitorsPage'
import NetworkMapPage from './pages/NetworkMapPage'
import './styles.css'

function App() {
  return (
    <BrowserRouter>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">BaumLab</div>
          <NavLink to="/" end>Network Map</NavLink>
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/monitors">Monitors</NavLink>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<NetworkMapPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/monitors" element={<MonitorsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)

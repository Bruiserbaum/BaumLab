import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi, useAuth } from '../../auth'
import { API, Notice, RunLog, apiJson } from './common'
import { Overview, History, ImportTab } from './Overview'
import Jobs from './Jobs'
import Stacks from './Stacks'
import Kits from './Kits'
import Destinations from './Destinations'

const TABS = [
  ['overview', 'Overview'],
  ['kits', 'Recovery kits'],
  ['jobs', 'Jobs'],
  ['stacks', 'Stacks'],
  ['destinations', 'Destinations'],
  ['history', 'History'],
  ['import', 'Import'],
]

export default function BackupsPage() {
  const api = useApi()
  const { isAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'overview'
  const [status, setStatus] = useState(null)
  const [destinations, setDestinations] = useState([])
  const [services, setServices] = useState([])
  const [notice, setNotice] = useState(null)
  const [runLogId, setRunLogId] = useState(null)
  const [historyFilter, setHistoryFilter] = useState(null)
  const [jobPrefill, setJobPrefill] = useState(null)

  const setTab = t => setParams({ tab: t })

  async function loadDestinations() {
    apiJson(api, `${API}/destinations`).then(setDestinations).catch(() => {})
  }

  useEffect(() => {
    if (!isAdmin) return
    apiJson(api, `${API}/status`).then(setStatus).catch(e => setStatus({ docker: false, error: e.message }))
    loadDestinations()
    apiJson(api, '/api/services/').then(list => setServices(list.filter(s => s.status !== 'decommissioned'))).catch(() => {})
  }, [isAdmin])

  // Arriving from the Services page ("set up a backup job next"): open a job form for that service
  useEffect(() => {
    const sid = Number(params.get('service'))
    const svc = sid && services.find(s => s.id === sid)
    if (svc) {
      setJobPrefill({ name: svc.name, service_ids: [svc.id] })
      setParams({ tab: 'jobs' })
    }
  }, [services])

  if (!isAdmin) return <div><h1>Backups</h1><p style={{ color: 'var(--text-muted)' }}>Admin access required.</p></div>

  const shared = { api, notify: setNotice, destinations, services }

  return (
    <div>
      <h1>Backups</h1>

      {status && !status.docker && (
        <div className="card" style={{ borderColor: 'var(--red)', fontSize: 13 }}>
          <b style={{ color: 'var(--red)' }}>Backups can't run here.</b> {status.error}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            The api container needs <code>/var/run/docker.sock</code> and <code>/tmp/baumlab-backup</code> mounted (see docker-compose.yml).
          </div>
        </div>
      )}
      {status?.docker && !status.rclone && (
        <div className="card" style={{ borderColor: 'var(--yellow)', fontSize: 13 }}>rclone is missing from the api image — rebuild it.</div>
      )}
      {status?.docker && status.tmp_dir_ok === false && (
        <div className="card" style={{ borderColor: 'var(--yellow)', fontSize: 13 }}>
          Scratch folder <code>{status.tmp_dir}</code> isn't mounted — volume archives will fail.
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
              borderRadius: 0, color: tab === id ? 'var(--text)' : 'var(--text-muted)', padding: '8px 12px' }}>
            {label}
          </button>
        ))}
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />

      {tab === 'overview' && (
        <Overview api={api} notify={setNotice} openRunLog={setRunLogId}
          onCreateJob={s => { setJobPrefill({ name: s.name, service_ids: [s.id] }); setTab('jobs') }} />
      )}
      {tab === 'jobs' && (
        <Jobs {...shared} prefill={jobPrefill} clearPrefill={() => setJobPrefill(null)}
          openRun={f => { setHistoryFilter(f); setTab('history') }} />
      )}
      {tab === 'kits' && <Kits {...shared} openRun={f => { setHistoryFilter(f); setTab('history') }} />}
      {tab === 'stacks' && <Stacks {...shared} openRun={f => { setHistoryFilter(f); setTab('history') }} />}
      {tab === 'destinations' && <Destinations {...shared} reload={loadDestinations} />}
      {tab === 'history' && <History api={api} notify={setNotice} filter={historyFilter} setFilter={setHistoryFilter} openRunLog={setRunLogId} />}
      {tab === 'import' && <ImportTab api={api} notify={setNotice} onImported={() => { loadDestinations(); setTab('jobs') }} />}

      {runLogId && <RunLog api={api} runId={runLogId} onClose={() => setRunLogId(null)} />}
    </div>
  )
}

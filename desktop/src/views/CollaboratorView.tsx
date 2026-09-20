import { useMemo, useRef, useState } from 'react'
import { Copy, Globe2, Plus, Power, Radar, RefreshCw, Server, Trash2 } from 'lucide-react'
import { api } from '../api'
import { Button, Editor, Empty } from '../components'
import type { WorkspaceController } from '../hooks/useWorkspace'
import type { OastInteraction } from '../types'

const PROTOCOL_LABELS: Record<string, string> = {
  dns: 'DNS',
  http: 'HTTP',
  https: 'HTTPS',
  smtp: 'SMTP',
  smtps: 'SMTPS',
  ftp: 'FTP',
  ldap: 'LDAP',
}

const INTERACTION_ROW_HEIGHT = 34
const INTERACTION_OVERSCAN = 8

function protocolLabel(protocol: string) {
  return PROTOCOL_LABELS[protocol.toLowerCase()] ?? protocol.toUpperCase()
}

function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

export function CollaboratorView({ workspace }: { workspace: WorkspaceController }) {
  const {
    online,
    oastServers,
    oastServer,
    setOastServer,
    oastToken,
    setOastToken,
    oastStatus,
    oastInteractions,
    oastSelected,
    setOastSelected,
    oastBusy,
    registerOast,
    generateOastDomain,
    pollOastNow,
    clearOastInteractions,
    stopOast,
    setNotice,
  } = workspace
  const interactionsScroll = useRef<HTMLDivElement>(null)
  const [interactionStart, setInteractionStart] = useState(0)

  const active = oastStatus?.active ?? false
  const domains = oastStatus?.domains ?? []
  const selected = useMemo<OastInteraction | null>(() => {
    if (!oastSelected) return oastInteractions[0] ?? null
    return oastInteractions.find((i) => i.unique_id === oastSelected) ?? oastInteractions[0] ?? null
  }, [oastInteractions, oastSelected])

  const copy = (text: string, message: string) => {
    void api.copyText(text)
    setNotice(message)
  }

  const requestText =
    selected?.raw_request ??
    (selected
      ? `Protocol: ${protocolLabel(selected.protocol)}\n` +
        `Full ID:  ${selected.full_id}\n` +
        `Source:   ${selected.remote_address}\n` +
        (selected.q_type ? `Query:    ${selected.q_type}\n` : '') +
        (selected.smtp_from ? `SMTP from: ${selected.smtp_from}\n` : '') +
        `Time:     ${formatTime(selected.timestamp)}`
      : '')
  const visibleInteractions = oastInteractions.slice(
    interactionStart,
    interactionStart + 40 + INTERACTION_OVERSCAN * 2,
  )

  return (
    <div className="tool-workspace collaborator">
      <div className="tool-toolbar collaborator-toolbar">
        <label className="attack-type-field">
          <span>OAST server</span>
          <select
            aria-label="OAST server"
            value={oastServer}
            disabled={oastBusy}
            onChange={(e) => setOastServer(e.target.value)}
          >
            {!oastServers.includes(oastServer) && oastServer && (
              <option value={oastServer}>{oastServer}</option>
            )}
            {oastServers.map((server) => (
              <option key={server} value={server}>
                {server}
              </option>
            ))}
          </select>
        </label>
        <label className="target-input collaborator-token">
          <Server size={15} />
          <input
            aria-label="OAST auth token (optional)"
            placeholder="Auth token (optional)"
            value={oastToken}
            disabled={oastBusy}
            onChange={(e) => setOastToken(e.target.value)}
          />
        </label>
        <span className="grow" />
        <span className={`oast-status ${active ? 'live' : ''}`}>
          <span className={`dot ${active ? 'green' : ''}`} />
          {active ? `Polling ${oastStatus?.server}` : 'Not registered'}
        </span>
        {active ? (
          <Button className="danger" disabled={oastBusy} onClick={() => void stopOast()}>
            <Power size={13} />
            Stop
          </Button>
        ) : (
          <Button
            className="primary"
            disabled={!online || oastBusy || !oastServer}
            onClick={() => void registerOast()}
          >
            <Radar size={13} />
            Register
          </Button>
        )}
      </div>

      {oastStatus?.error && (
        <div className="oast-error" role="alert">
          {oastStatus.error}
        </div>
      )}

      <section className="oast-domains">
        <div className="panel-title">
          <span>
            <Globe2 size={14} />
            Callback domains
          </span>
          <div className="panel-actions">
            <Button
              className="subtle"
              disabled={!active || oastBusy}
              onClick={() => void generateOastDomain()}
            >
              <Plus size={13} />
              New domain
            </Button>
          </div>
        </div>
        {domains.length === 0 ? (
          <p className="oast-hint">
            Register with an OAST server, then generate a domain and paste it into a target. Any
            DNS, HTTP, or SMTP callback it receives shows up below.
          </p>
        ) : (
          <ul className="oast-domain-list">
            {domains.map((domain) => (
              <li key={domain.id}>
                <code>{domain.domain}</code>
                {domain.hits > 0 && (
                  <span className="oast-hits">
                    {domain.hits} hit{domain.hits === 1 ? '' : 's'}
                  </span>
                )}
                <button
                  className="icon-button"
                  aria-label={`Copy ${domain.domain}`}
                  title="Copy domain"
                  onClick={() => copy(domain.domain, 'Copied OAST domain to clipboard')}
                >
                  <Copy size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="oast-split">
        <section className="oast-interactions">
          <div className="panel-title">
            <span>
              <Radar size={14} />
              Interactions
            </span>
            <div className="panel-actions">
              <small>{oastInteractions.length}</small>
              <Button
                className="subtle"
                disabled={!active || oastBusy}
                onClick={() => void pollOastNow()}
              >
                <RefreshCw size={13} />
                Poll now
              </Button>
              <Button
                className="subtle"
                disabled={oastInteractions.length === 0}
                onClick={() => void clearOastInteractions()}
              >
                <Trash2 size={13} />
                Clear
              </Button>
            </div>
          </div>
          {oastInteractions.length === 0 ? (
            <Empty icon={<RefreshCw size={22} />} title="Waiting for interactions">
              {active
                ? `Polling every ${oastStatus?.poll_interval ?? 5}s. Trigger a callback to your domain to see it here.`
                : 'Register with an OAST server to start listening.'}
            </Empty>
          ) : (
            <div className="oast-table" role="table">
              <div className="oast-row oast-head" role="row">
                <span role="columnheader">Type</span>
                <span role="columnheader">Source</span>
                <span role="columnheader">Full ID</span>
                <span role="columnheader">Time</span>
              </div>
              <div
                className="oast-rows"
                ref={interactionsScroll}
                onScroll={(event) => {
                  const first = Math.max(
                    0,
                    Math.floor(event.currentTarget.scrollTop / INTERACTION_ROW_HEIGHT) -
                      INTERACTION_OVERSCAN,
                  )
                  setInteractionStart((current) => (current === first ? current : first))
                }}
              >
                <div
                  style={{
                    height: oastInteractions.length * INTERACTION_ROW_HEIGHT,
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: interactionStart * INTERACTION_ROW_HEIGHT,
                      left: 0,
                      right: 0,
                    }}
                  >
                    {visibleInteractions.map((interaction) => (
                      <button
                        key={interaction.unique_id + interaction.timestamp}
                        className={`oast-row ${
                          selected && selected.unique_id === interaction.unique_id ? 'active' : ''
                        }`}
                        role="row"
                        onClick={() => setOastSelected(interaction.unique_id)}
                      >
                        <span role="cell">
                          <span
                            className={`oast-proto proto-${interaction.protocol.toLowerCase()}`}
                          >
                            {protocolLabel(interaction.protocol)}
                          </span>
                        </span>
                        <span role="cell">{interaction.remote_address}</span>
                        <span role="cell" className="oast-fullid" title={interaction.full_id}>
                          {interaction.full_id}
                        </span>
                        <span role="cell">{formatTime(interaction.timestamp)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
        <section className="oast-detail">
          <Editor
            title={selected ? `${protocolLabel(selected.protocol)} request` : 'Request'}
            value={requestText}
            hint={selected ? selected.remote_address : undefined}
          />
          <Editor title="Response" value={selected?.raw_response ?? ''} />
        </section>
      </div>
    </div>
  )
}

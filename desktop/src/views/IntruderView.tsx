import { useRef, useState } from 'react'
import {
  Crosshair,
  Eraser,
  Eye,
  Globe2,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  Square,
  X,
  Zap,
} from 'lucide-react'
import { api } from '../api'
import { Button, Editor } from '../components'

import type { WorkspaceController } from '../hooks/useWorkspace'
import {
  ATTACK_TYPES,
  generatePayloads,
  newIntruderTab,
  payloadSetCount,
  type PayloadType,
} from '../hooks/useWorkspace'
import { IntruderRunModal } from './IntruderRunModal'

const PAYLOAD_TYPES: PayloadType[] = [
  'Simple list',
  'Runtime file',
  'Custom iterator',
  'Character substitution',
  'Case modification',
  'Recursive grep',
  'Illegal Unicode',
  'Character blocks',
  'Numbers',
  'Dates',
  'Brute forcer',
  'Null payloads',
  'Character frobber',
  'Bit flipper',
  'Username generator',
]

// Types materialised into a payload list entirely on the client.
const SUPPORTED_TYPES = new Set<PayloadType>([
  'Simple list',
  'Numbers',
  'Dates',
  'Brute forcer',
  'Null payloads',
  'Username generator',
])

export function IntruderView({ workspace }: { workspace: WorkspaceController }) {
  const {
    state,
    online,
    attackRequest,
    setAttackRequest,
    attackUrl,
    setAttackUrl,
    attackType,
    setAttackType,
    concurrency,
    setIntruderConcurrency,
    payloadConfigs,
    setPayloadConfig,
    addPayloadPoint,
    clearPayloadPoints,
    payloadPositions,
    intruderRequestCount,
    intruderTabs,
    setIntruderTabs,
    activeIntruderTab,
    setActiveIntruderTab,
    intruderSequence,
    intruderRunningIds,
    startIntruder,
    cancelIntruder,
    openIntruderResults,
    duplicateIntruderTab,
  } = workspace
  const requestRef = useRef<HTMLTextAreaElement>(null)
  const running =
    workspace.intruderTab.runState === 'running' || workspace.intruderTab.runState === 'queued'
  // Which payload set the editor is currently targeting. Sniper/battering ram
  // only have one; pitchfork/cluster bomb have one per position.
  const [activeSet, setActiveSet] = useState(0)
  const setCount = payloadSetCount(attackType, payloadPositions)
  const usesMultipleSets = setCount > 1
  const setIndex = Math.min(activeSet, payloadConfigs.length - 1)
  const config = payloadConfigs[setIndex] ?? payloadConfigs[0]
  const markedValues = attackRequest.match(/\u00a7[^\u00a7]*\u00a7/g) ?? []
  const payloadCount = generatePayloads(config).length
  const supported = SUPPORTED_TYPES.has(config.type)
  const usesList =
    config.type === 'Simple list' ||
    config.type === 'Username generator' ||
    !SUPPORTED_TYPES.has(config.type)
  const requestCount = intruderRequestCount
  const patchConfig = (patch: Partial<typeof config>) => setPayloadConfig(patch, setIndex)

  const insertPayloadPoint = () => {
    const el = requestRef.current
    if (!el) {
      addPayloadPoint(attackRequest.length, attackRequest.length)
      return
    }
    addPayloadPoint(el.selectionStart, el.selectionEnd)
  }

  return (
    <div className="tool-workspace">
      <div className="request-tabs">
        {intruderTabs.map((tab) => (
          <div
            className={`request-tab ${tab.id === activeIntruderTab ? 'active' : ''}`}
            key={tab.id}
          >
            <button onClick={() => setActiveIntruderTab(tab.id)}>
              {intruderRunningIds.includes(tab.id) ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Zap size={12} />
              )}
              <span>{tab.name}</span>
            </button>
            {tab.attackId && tab.results.length > 0 && (
              <button
                className="icon-button request-tab-results"
                aria-label={`View results for ${tab.name}`}
                title="View attack results"
                onClick={() => openIntruderResults(tab.id)}
              >
                <Eye size={12} />
              </button>
            )}
            {intruderTabs.length > 1 && (
              <button
                aria-label={`Close ${tab.name}`}
                disabled={tab.runState === 'running' || tab.runState === 'queued'}
                onClick={() => {
                  setIntruderTabs(intruderTabs.filter((t) => t.id !== tab.id))
                  if (tab.id === activeIntruderTab)
                    setActiveIntruderTab(intruderTabs.find((t) => t.id !== tab.id)!.id)
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <button
          className="icon-button"
          aria-label="New Intruder attack"
          onClick={() => {
            const id = ++intruderSequence.current
            setIntruderTabs((prev) => [...prev, newIntruderTab(id)])
            setActiveIntruderTab(id)
          }}
        >
          <Plus size={16} />
        </button>
        <button
          className="icon-button"
          aria-label="Duplicate Intruder attack"
          title="Duplicate attack (Ctrl+I)"
          onClick={duplicateIntruderTab}
        >
          <Layers3 size={15} />
        </button>
      </div>
      <div className="tool-toolbar">
        <label className="target-input">
          <Globe2 size={15} />
          <input
            aria-label="Intruder target URL"
            value={attackUrl}
            disabled={running}
            onChange={(e) => setAttackUrl(e.target.value)}
          />
        </label>
        <label className="attack-type-field">
          <span>Attack type</span>
          <select
            aria-label="Attack type"
            value={attackType}
            disabled={running}
            title={ATTACK_TYPES.find((a) => a.value === attackType)?.description}
            onChange={(e) => {
              setAttackType(e.target.value as (typeof ATTACK_TYPES)[number]['value'])
              setActiveSet(0)
            }}
          >
            {ATTACK_TYPES.map((a) => (
              <option key={a.value} value={a.value} title={a.description}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="attack-type-field" title="Maximum number of Intruder requests in flight">
          <span>Concurrency</span>
          <input
            aria-label="Intruder concurrency"
            type="number"
            min={1}
            max={64}
            value={concurrency}
            disabled={running}
            onChange={(e) => setIntruderConcurrency(Number(e.target.value))}
          />
        </label>
        <span className="muted">{state.job_state}</span>
        {running ? (
          <Button className="danger" onClick={() => void cancelIntruder()}>
            <Square size={12} />
            Cancel run
          </Button>
        ) : (
          <Button
            className="primary"
            disabled={!online || requestCount === 0}
            onClick={() => void startIntruder()}
          >
            <Play size={13} />
            Start run
          </Button>
        )}
      </div>
      <div className="attack-split">
        <section className="attack-request">
          <div className="payload-point-bar">
            <span className="payload-point-hint">
              <Crosshair size={13} />
              {payloadPositions
                ? `${payloadPositions} payload position${payloadPositions === 1 ? '' : 's'}`
                : 'Select text, then add a payload position'}
            </span>
            <span className="grow" />
            <Button
              className="subtle"
              disabled={running}
              // Preserve the textarea selection. Without this, the browser
              // can collapse the selection when focus moves to the button,
              // causing markers to be inserted at the wrong offset.
              onMouseDown={(event) => event.preventDefault()}
              onClick={insertPayloadPoint}
            >
              <Plus size={13} />
              Add §
            </Button>
            <Button
              className="subtle"
              disabled={running || payloadPositions === 0}
              onClick={clearPayloadPoints}
            >
              <Eraser size={13} />
              Clear §
            </Button>
          </div>
          <Editor
            title="Request template"
            value={attackRequest}
            onChange={setAttackRequest}
            disabled={running}
            textareaRef={requestRef}
            rawOnly
          />
        </section>
        <section className="payload-config">
          <div className="panel-title">
            <span>
              <Layers3 size={14} />
              Payloads
            </span>
            <small>
              {payloadCount} value{payloadCount === 1 ? '' : 's'}
            </small>
          </div>
          <div className="payload-config-body">
            <p className="attack-type-note">
              {ATTACK_TYPES.find((a) => a.value === attackType)?.description}
            </p>
            <div className="payload-field">
              <label htmlFor="payload-position">Payload set</label>
              <select
                id="payload-position"
                value={setIndex}
                disabled={running || !usesMultipleSets}
                title={
                  usesMultipleSets
                    ? 'Choose the payload set assigned to each marked position'
                    : 'Sniper and Battering ram use one shared payload set'
                }
                onChange={(e) => setActiveSet(Number(e.target.value))}
              >
                {usesMultipleSets ? (
                  Array.from({ length: setCount }, (_, i) => (
                    <option key={i} value={i}>
                      Position {i + 1}
                    </option>
                  ))
                ) : (
                  <option value={0}>All payload positions</option>
                )}
              </select>
            </div>
            <div className="payload-position-list" aria-label="Payload positions">
              {usesMultipleSets ? (
                markedValues.map((value, index) => (
                  <button
                    type="button"
                    key={index}
                    className={index === setIndex ? 'active' : ''}
                    disabled={running}
                    onClick={() => setActiveSet(index)}
                    title={`Edit payload set for position ${index + 1}: ${value}`}
                  >
                    <span>Position {index + 1}</span>
                    <code>{value.slice(1, -1) || '(empty)'}</code>
                  </button>
                ))
              ) : (
                <span className="payload-position-shared">Shared set for all positions</span>
              )}
            </div>
            <div className="payload-field">
              <label htmlFor="payload-type">Payload type</label>
              <select
                id="payload-type"
                value={config.type}
                disabled={running}
                onChange={(e) => patchConfig({ type: e.target.value as PayloadType })}
              >
                {PAYLOAD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="payload-counts">
              <div>
                <em>Payload count</em>
                <strong>{payloadCount.toLocaleString()}</strong>
              </div>
              <div>
                <em>Request count</em>
                <strong>{requestCount.toLocaleString()}</strong>
              </div>
            </div>

            <div className="payload-section-title">Payload configuration</div>
            {!supported && (
              <p className="payload-note">
                This payload type isn't generated by the engine yet. Enter values below and they run
                as a simple list.
              </p>
            )}

            {usesList && (
              <textarea
                className="payload-list"
                aria-label="Payload values"
                placeholder={
                  config.type === 'Username generator'
                    ? 'One full name per line…'
                    : 'One payload per line…'
                }
                value={config.list}
                disabled={running}
                onChange={(e) => patchConfig({ list: e.target.value })}
              />
            )}

            {config.type === 'Numbers' && (
              <>
                <div className="payload-section-title">Number range</div>
                <div className="payload-field">
                  <label>Type</label>
                  <select
                    value={config.numberType}
                    disabled={running}
                    onChange={(e) =>
                      patchConfig({
                        numberType: e.target.value as 'Sequential' | 'Random',
                      })
                    }
                  >
                    <option>Sequential</option>
                    <option>Random</option>
                  </select>
                </div>
                <div className="payload-field">
                  <label>From</label>
                  <input
                    type="number"
                    value={config.from}
                    disabled={running}
                    onChange={(e) => patchConfig({ from: Number(e.target.value) })}
                  />
                </div>
                <div className="payload-field">
                  <label>To</label>
                  <input
                    type="number"
                    value={config.to}
                    disabled={running}
                    onChange={(e) => patchConfig({ to: Number(e.target.value) })}
                  />
                </div>
                {config.numberType === 'Sequential' ? (
                  <div className="payload-field">
                    <label>Step</label>
                    <input
                      type="number"
                      value={config.step}
                      disabled={running}
                      onChange={(e) => patchConfig({ step: Number(e.target.value) })}
                    />
                  </div>
                ) : (
                  <div className="payload-field">
                    <label>How many</label>
                    <input
                      type="number"
                      value={config.howMany}
                      disabled={running}
                      onChange={(e) => patchConfig({ howMany: Number(e.target.value) })}
                    />
                  </div>
                )}
                <div className="payload-section-title">Number format</div>
                <div className="payload-field radio-field">
                  <label>Base</label>
                  <div className="radio-group">
                    <label className="radio">
                      <input
                        type="radio"
                        name="number-base"
                        checked={config.numberBase === 'Decimal'}
                        disabled={running}
                        onChange={() => patchConfig({ numberBase: 'Decimal' })}
                      />
                      Decimal
                    </label>
                    <label className="radio">
                      <input
                        type="radio"
                        name="number-base"
                        checked={config.numberBase === 'Hex'}
                        disabled={running}
                        onChange={() => patchConfig({ numberBase: 'Hex' })}
                      />
                      Hex
                    </label>
                  </div>
                </div>
                <div className="payload-field">
                  <label>Min integer digits</label>
                  <input
                    type="number"
                    min={0}
                    value={config.minIntegerDigits}
                    disabled={running}
                    onChange={(e) => patchConfig({ minIntegerDigits: Number(e.target.value) })}
                  />
                </div>
              </>
            )}

            {config.type === 'Dates' && (
              <>
                <div className="payload-section-title">Date range</div>
                <div className="payload-field">
                  <label>From</label>
                  <input
                    type="date"
                    value={config.dateFrom}
                    disabled={running}
                    onChange={(e) => patchConfig({ dateFrom: e.target.value })}
                  />
                </div>
                <div className="payload-field">
                  <label>To</label>
                  <input
                    type="date"
                    value={config.dateTo}
                    disabled={running}
                    onChange={(e) => patchConfig({ dateTo: e.target.value })}
                  />
                </div>
                <div className="payload-field">
                  <label>Step (days)</label>
                  <input
                    type="number"
                    min={1}
                    value={config.dateStep}
                    disabled={running}
                    onChange={(e) => patchConfig({ dateStep: Number(e.target.value) })}
                  />
                </div>
                <div className="payload-field">
                  <label>Format</label>
                  <input
                    value={config.dateFormat}
                    disabled={running}
                    onChange={(e) => patchConfig({ dateFormat: e.target.value })}
                  />
                </div>
              </>
            )}

            {config.type === 'Brute forcer' && (
              <>
                <div className="payload-section-title">Brute force</div>
                <div className="payload-field">
                  <label>Character set</label>
                  <input
                    value={config.charset}
                    disabled={running}
                    onChange={(e) => patchConfig({ charset: e.target.value })}
                  />
                </div>
                <div className="payload-field">
                  <label>Min length</label>
                  <input
                    type="number"
                    min={1}
                    value={config.minLength}
                    disabled={running}
                    onChange={(e) => patchConfig({ minLength: Number(e.target.value) })}
                  />
                </div>
                <div className="payload-field">
                  <label>Max length</label>
                  <input
                    type="number"
                    min={1}
                    value={config.maxLength}
                    disabled={running}
                    onChange={(e) => patchConfig({ maxLength: Number(e.target.value) })}
                  />
                </div>
              </>
            )}

            {config.type === 'Null payloads' && (
              <>
                <div className="payload-section-title">Null payloads</div>
                <div className="payload-field">
                  <label>How many</label>
                  <input
                    type="number"
                    min={1}
                    value={config.nullCount}
                    disabled={running}
                    onChange={(e) => patchConfig({ nullCount: Number(e.target.value) })}
                  />
                </div>
              </>
            )}

            <small className="payload-footnote">
              Sequential requests · 100 ms interval · up to 1,000 payloads
            </small>
          </div>
        </section>
      </div>
      <IntruderRunModal workspace={workspace} />
    </div>
  )
}

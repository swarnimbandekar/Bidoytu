import {
  ArrowLeftRight,
  Code2,
  Crosshair,
  Radar,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  EMPTY_HISTORY_FILTERS,
  countActiveFilters,
  historyFilterPayload,
  type HistoryFilters,
} from '../historyFilters'
import type {
  Detail,
  EngineState,
  Finding,
  Flow,
  JobResult,
  OastInteraction,
  OastStatus,
} from '../types'

export type View =
  | 'Proxy'
  | 'Repeater'
  | 'Intruder'
  | 'Collaborator'
  | 'Scope'
  | 'Live audit'
  | 'Decoder'
  | 'Settings'
export type RepeaterTab = {
  id: number
  name: string
  url: string
  request: string
  response?: string
  result?: Detail
  busy: boolean
  error?: string
  history?: RepeaterRevision[]
  historyIndex?: number
}
export type RepeaterRevision = { request: string; result: Detail }
export type RepeaterGroup = {
  name: string
  color: string
  tabIds: number[]
  collapsed: boolean
}
// The four classic Intruder attack strategies. The wire values match the
// backend constants in bidoytu.net.attack.
export type AttackType = 'sniper' | 'battering_ram' | 'pitchfork' | 'cluster_bomb'
export const ATTACK_TYPES: {
  value: AttackType
  label: string
  description: string
}[] = [
  {
    value: 'sniper',
    label: 'Sniper',
    description:
      'Inserts each payload into each position one at a time, using a single payload set.',
  },
  {
    value: 'battering_ram',
    label: 'Battering ram',
    description:
      'Simultaneously places the same payload into all positions, using a single payload set.',
  },
  {
    value: 'pitchfork',
    label: 'Pitchfork',
    description:
      'Allocate a payload set to each position. Iterates through each set in parallel.',
  },
  {
    value: 'cluster_bomb',
    label: 'Cluster bomb',
    description:
      'Allocate a payload set to each position. Iterates through all combinations of each set.',
  },
]
export type PayloadType =
  | 'Simple list'
  | 'Runtime file'
  | 'Custom iterator'
  | 'Character substitution'
  | 'Case modification'
  | 'Recursive grep'
  | 'Illegal Unicode'
  | 'Character blocks'
  | 'Numbers'
  | 'Dates'
  | 'Brute forcer'
  | 'Null payloads'
  | 'Character frobber'
  | 'Bit flipper'
  | 'Username generator'
export type NumberFormat = { base: 'Decimal' | 'Hex' }
export type PayloadConfig = {
  position: string
  type: PayloadType
  // Simple list
  list: string
  // Numbers
  numberType: 'Sequential' | 'Random'
  from: number
  to: number
  step: number
  howMany: number
  numberBase: 'Decimal' | 'Hex'
  minIntegerDigits: number
  maxIntegerDigits: number
  // Dates
  dateFrom: string
  dateTo: string
  dateStep: number
  dateFormat: string
  // Brute forcer
  charset: string
  minLength: number
  maxLength: number
  // Null payloads
  nullCount: number
}
export type IntruderTab = {
  id: number
  name: string
  url: string
  request: string
  attackType: AttackType
  concurrency: number
  attackId?: string
  runState: 'idle' | 'queued' | 'running' | 'complete' | 'cancelled'
  // One payload-set config per position. Sniper and battering ram only use
  // configs[0]; pitchfork and cluster bomb use one set per marked position.
  configs: PayloadConfig[]
  results: JobResult[]
}
export type ProxyView = 'History' | 'Intercept'
const initial: EngineState = {
  protocol: 1,
  running: false,
  port: 8080,
  host: '127.0.0.1',
  intercept: false,
  responses: false,
  pending: [],
  audit: false,
  findings: 0,
  dropped: 0,
  queue_depth: 0,
  error: '',
  data_dir: '',
  scope: { include: [], exclude: [] },
  job_state: 'idle',
}
export const icons = {
  Proxy: Radio,
  Repeater: Send,
  Intruder: Zap,
  Collaborator: Radar,
  Scope: Crosshair,
  'Live audit': ShieldCheck,
  Decoder: Code2,
  Settings: Settings2,
}
export const descriptions: Record<View, string> = {
  Proxy: 'Capture, inspect, and shape traffic in flight.',
  Repeater: 'Refine a request. Explore the response.',
  Intruder: 'Controlled payload testing, powered by Python.',
  Collaborator: 'Detect out-of-band interactions with OAST domains.',
  Scope: 'Define the boundaries of your investigation.',
  'Live audit': 'Evidence from the traffic you already capture.',
  Decoder: 'Make encoded data readable.',
  Settings: 'Your engine. Your workspace.',
}
export const newTab = (id: number): RepeaterTab => ({
  id,
  name: `Request ${id}`,
  url: 'https://example.com',
  request: 'GET / HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n',
  busy: false,
})

function nextRepeaterCopyName(name: string, tabs: RepeaterTab[]) {
  const stem = name.replace(/\s*\(\d+\)\s*$/, '').trim() || 'Request'
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\((\\d+)\\)$`,
  )
  const used = new Set<number>()
  for (const tab of tabs) {
    const match = tab.name.trim().match(pattern)
    if (match) used.add(Number(match[1]))
  }
  let index = 1
  while (used.has(index)) index += 1
  return `${stem} (${index})`
}

function nextIntruderCopyName(name: string, tabs: IntruderTab[]) {
  const stem = name.replace(/\s*\(\d+\)\s*$/, '').trim() || 'Attack'
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\((\\d+)\\)$`,
  )
  const used = new Set<number>()
  for (const tab of tabs) {
    const match = tab.name.trim().match(pattern)
    if (match) used.add(Number(match[1]))
  }
  let index = 1
  while (used.has(index)) index += 1
  return `${stem} (${index})`
}
export const defaultPayloadConfig = (): PayloadConfig => ({
  position: 'All payload positions',
  type: 'Simple list',
  list: '',
  numberType: 'Sequential',
  from: 1,
  to: 100,
  step: 1,
  howMany: 10,
  numberBase: 'Decimal',
  minIntegerDigits: 0,
  maxIntegerDigits: 2,
  dateFrom: '2020-01-01',
  dateTo: '2020-12-31',
  dateStep: 1,
  dateFormat: 'yyyy-MM-dd',
  charset: 'abcdefghijklmnopqrstuvwxyz0123456789',
  minLength: 1,
  maxLength: 3,
  nullCount: 10,
})
export const newIntruderTab = (id: number): IntruderTab => ({
  id,
  name: `Attack ${id}`,
  url: 'https://example.com',
  request: 'GET /?q=§value§ HTTP/1.1\r\nHost: example.com\r\n\r\n',
  attackType: 'sniper',
  concurrency: 10,
  runState: 'idle',
  configs: [defaultPayloadConfig()],
  results: [],
})

// Sniper and battering ram use a single shared payload set; pitchfork and
// cluster bomb use one set per position. This returns how many payload sets an
// attack of the given type needs for a template with `positions` markers.
export function payloadSetCount(attackType: AttackType, positions: number): number {
  if (attackType === 'sniper' || attackType === 'battering_ram') return 1
  return Math.max(1, positions)
}

// Total number of requests a configured attack will send. Mirrors the
// backend's count_jobs so the UI can preview the run size.
export function intruderRequestCount(tab: IntruderTab): number {
  const positions = countPayloadPositions(tab.request)
  if (positions === 0) return 0
  const needed = payloadSetCount(tab.attackType, positions)
  const configs = reconcileConfigs(tab.configs, tab.attackType, positions).slice(0, needed)
  const counts = configs.map((config) => generatePayloads(config).length)
  if (counts.some((c) => c === 0)) return 0
  switch (tab.attackType) {
    case 'sniper':
      return counts[0] * positions
    case 'battering_ram':
      return counts[0]
    case 'pitchfork':
      return Math.min(...counts)
    case 'cluster_bomb':
      return counts.reduce((total, c) => total * c, 1)
    default:
      return 0
  }
}

// Ensure a tab has exactly the payload-set configs its attack type + position
// count require, preserving any already-entered configs.
export function reconcileConfigs(
  configs: PayloadConfig[],
  attackType: AttackType,
  positions: number,
): PayloadConfig[] {
  const needed = payloadSetCount(attackType, positions)
  const next = configs.slice(0, needed)
  while (next.length < needed) next.push(defaultPayloadConfig())
  if (next.length === 0) next.push(defaultPayloadConfig())
  return next
}

// Count the number of payload positions in a request template. A position is
// any span between a pair of § markers (an unpaired trailing § is ignored).
export function countPayloadPositions(request: string): number {
  const matches = request.match(/§[^§]*§/g)
  return matches ? matches.length : 0
}

function pad(value: string, length: number): string {
  return value.length >= length ? value : '0'.repeat(length - value.length) + value
}

// Deterministically build the list of payload strings from a payload config.
// The backend accepts a flat list of strings, so every payload type is
// materialised client-side into that list (capped at 1000 to match the engine).
export function generatePayloads(config: PayloadConfig): string[] {
  const cap = 1000
  const clamp = (values: string[]) => values.slice(0, cap)
  switch (config.type) {
    case 'Numbers': {
      const values: string[] = []
      const format = (n: number) => {
        if (config.numberBase === 'Hex') {
          const hex = Math.round(n).toString(16)
          return pad(hex, config.minIntegerDigits)
        }
        return pad(String(Math.round(n)), config.minIntegerDigits)
      }
      if (config.numberType === 'Random') {
        const count = Math.max(1, Math.min(cap, Math.round(config.howMany) || 10))
        const lo = Math.min(config.from, config.to)
        const hi = Math.max(config.from, config.to)
        for (let i = 0; i < count; i += 1) {
          // Generate an inclusive integer in the requested range. The old
          // interpolation + round could produce surprising distributions and
          // only generated one value when the default How many was zero.
          values.push(format(Math.floor(lo + Math.random() * (hi - lo + 1))))
        }
        return values
      }
      const step = config.step || 1
      const ascending = config.to >= config.from
      for (
        let n = config.from;
        (ascending ? n <= config.to : n >= config.to) && values.length < cap;
        n += ascending ? Math.abs(step) : -Math.abs(step)
      ) {
        values.push(format(n))
        if (step === 0) break
      }
      return values
    }
    case 'Dates': {
      const values: string[] = []
      const start = new Date(config.dateFrom)
      const end = new Date(config.dateTo)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []
      const step = Math.max(1, Math.round(config.dateStep) || 1)
      for (
        let d = new Date(start);
        d.getTime() <= end.getTime() && values.length < cap;
        d.setDate(d.getDate() + step)
      ) {
        const yyyy = String(d.getFullYear())
        const mm = pad(String(d.getMonth() + 1), 2)
        const dd = pad(String(d.getDate()), 2)
        values.push(config.dateFormat.replace('yyyy', yyyy).replace('MM', mm).replace('dd', dd))
      }
      return values
    }
    case 'Null payloads': {
      const count = Math.max(1, Math.min(cap, Math.round(config.nullCount) || 1))
      return Array.from({ length: count }, () => '')
    }
    case 'Brute forcer': {
      const chars = Array.from(config.charset)
      if (!chars.length) return []
      const values: string[] = []
      const minLen = Math.max(1, config.minLength)
      const maxLen = Math.max(minLen, config.maxLength)
      const build = (prefix: string, length: number) => {
        if (values.length >= cap) return
        if (prefix.length === length) {
          values.push(prefix)
          return
        }
        for (const c of chars) {
          if (values.length >= cap) return
          build(prefix + c, length)
        }
      }
      for (let length = minLen; length <= maxLen && values.length < cap; length += 1) {
        build('', length)
      }
      return values
    }
    case 'Username generator': {
      // Treat each input line as a full name and derive common username forms.
      const names = config.list
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean)
      const values: string[] = []
      for (const name of names) {
        const parts = name.toLowerCase().split(/\s+/)
        const first = parts[0] ?? ''
        const last = parts[parts.length - 1] ?? ''
        const forms = new Set<string>([
          name.toLowerCase().replace(/\s+/g, ''),
          first,
          last,
          first && last ? `${first}.${last}` : '',
          first && last ? `${first}${last}` : '',
          first && last ? `${first[0]}${last}` : '',
          first && last ? `${first}_${last}` : '',
        ])
        for (const form of forms) if (form) values.push(form)
      }
      return clamp(values)
    }
    default:
      // Simple list and every list-backed type share the textarea input.
      return clamp(config.list.split('\n').filter((line) => line.length > 0))
  }
}

export function useWorkspace() {
  const [view, setView] = useState<View>('Proxy')
  const [proxyView, setProxyView] = useState<ProxyView>('History')
  const [state, setState] = useState(initial)
  const [online, setOnline] = useState(false)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [flows, setFlows] = useState<Flow[]>([])
  const [total, setTotal] = useState(0)
  const [unfilteredTotal, setUnfilteredTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS)
  const [debouncedFilters, setDebouncedFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(0)
  const [historySort, setHistorySort] = useState<{
    key: 'id' | 'method' | 'host' | 'path' | 'status' | 'size' | 'time'
    direction: 'asc' | 'desc'
  }>({ key: 'id', direction: 'desc' })
  const [selected, setSelected] = useState<Detail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [port, setPort] = useState(8080)
  const [verifyTLS, setVerifyTLS] = useState(true)
  const [tabs, setTabs] = useState<RepeaterTab[]>([newTab(1)])
  const [groups, setGroups] = useState<RepeaterGroup[]>([])
  const [activeTab, setActiveTab] = useState(1)
  const tabSequence = useRef(1)
  const [interceptText, setInterceptText] = useState('')
  const [interceptOriginal, setInterceptOriginal] = useState('')
  const [interceptId, setInterceptId] = useState('')
  const [interceptDetail, setInterceptDetail] = useState<Detail | null>(null)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [findings, setFindings] = useState<Finding[]>([])
  const [oastServers, setOastServers] = useState<string[]>([])
  const [oastServer, setOastServer] = useState('')
  const [oastToken, setOastToken] = useState('')
  const [oastStatus, setOastStatus] = useState<OastStatus | null>(null)
  const [oastInteractions, setOastInteractions] = useState<OastInteraction[]>([])
  const [oastSelected, setOastSelected] = useState<string | null>(null)
  const [oastBusy, setOastBusy] = useState(false)
  const [decoderInput, setDecoderInput] = useState('')
  const [decoderOutput, setDecoderOutput] = useState('')
  const [operation, setOperation] = useState('base64.decode')
  const [intruderTabs, setIntruderTabs] = useState<IntruderTab[]>([newIntruderTab(1)])
  const [activeIntruderTab, setActiveIntruderTab] = useState(1)
  const intruderSequence = useRef(1)
  const [intruderRunningIds, setIntruderRunningIds] = useState<number[]>([])
  const [runTabId, setRunTabId] = useState<number | null>(null)
  const [showIntruderRun, setShowIntruderRun] = useState(false)
  const [runSelectedIndex, setRunSelectedIndex] = useState<number | null>(null)
  const [runDetail, setRunDetail] = useState<Detail | null>(null)
  const [runDetailLoading, setRunDetailLoading] = useState(false)
  const runDetailSequence = useRef(0)
  const intruderResultsSequence = useRef(0)
  const [showHelp, setShowHelp] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('bidoytu.theme') === 'dark'
      ? 'dark'
      : 'light',
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const detailSequence = useRef(0)
  const historyRequestSequence = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [split, setSplit] = useState(51)
  const [interceptSplit, setInterceptSplit] = useState(51)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const sendRun = useRef(0)
  const historyRef = useRef<HTMLDivElement>(null)
  const interceptRef = useRef<HTMLDivElement>(null)
  // Refs for values accessed by the stable keyboard listener (empty deps array).
  const viewRef = useRef(view)
  viewRef.current = view
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const interceptDetailRef = useRef(interceptDetail)
  interceptDetailRef.current = interceptDetail
  const requestTab = tabs.find((t) => t.id === activeTab) ?? tabs[0]
  const intruderTab = intruderTabs.find((t) => t.id === activeIntruderTab) ?? intruderTabs[0]
  const intruderRunTab =
    intruderTabs.find((t) => t.id === runTabId) ?? intruderTab
  const requestTabRef = useRef(requestTab)
  requestTabRef.current = requestTab
  const intruderTabRef = useRef(intruderTab)
  intruderTabRef.current = intruderTab
  const pending = state.pending.find((p) => p.flow_id === interceptId) ?? state.pending[0]

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
  }, [])
  const refresh = useCallback((next: EngineState) => {
    setState(next)
    setRevision((v) => v + 1)
  }, [])
  const updateFilters = useCallback((patch: Partial<HistoryFilters>) => {
    setFilters((previous) => ({ ...previous, ...patch }))
  }, [])
  const resetFilters = useCallback(() => setFilters(EMPTY_HISTORY_FILTERS), [])
  const clearHistory = useCallback(
    () =>
      run(async () => {
        await api.request('history.clear')
        setSelected(null)
        setSelectedId(null)
        setRevision((v) => v + 1)
        setNotice('HTTP history cleared')
      }),
    [run],
  )
  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters])

  useEffect(() => {
    if (!online) return
    let alive = true
    api
      .request<{
        tabs?: RepeaterTab[]
        groups?: RepeaterGroup[]
        // Loaded loosely: older sessions stored a single `config`/`payloads`
        // rather than `attackType`/`configs`, so we migrate per-tab below.
        intruderTabs?: (Partial<IntruderTab> & {
          id: number
          request: string
          url: string
          config?: Partial<PayloadConfig>
          payloads?: string
        })[]
        port?: number
        verifyTLS?: boolean
      } | null>('workspace.load')
      .then((saved) => {
        if (!alive || !saved) return
        if (
          Array.isArray(saved.tabs) &&
          saved.tabs.length &&
          saved.tabs.every(
            (tab) =>
              Number.isInteger(tab.id) &&
              typeof tab.request === 'string' &&
              typeof tab.url === 'string',
          )
        ) {
          setTabs(saved.tabs.map((tab) => ({ ...tab, busy: false })))
          setActiveTab(saved.tabs[0].id)
          tabSequence.current = Math.max(...saved.tabs.map((tab) => tab.id))
        }
        if (Array.isArray(saved.groups)) {
          setGroups(
            saved.groups
              .filter((group) => typeof group.name === 'string' && typeof group.color === 'string')
              .map((group) => ({
                name: group.name,
                color: group.color,
                tabIds: Array.isArray(group.tabIds) ? group.tabIds.filter(Number.isInteger) : [],
                collapsed: Boolean(group.collapsed),
              })),
          )
        }
        if (
          Array.isArray(saved.intruderTabs) &&
          saved.intruderTabs.length &&
          saved.intruderTabs.every(
            (tab) =>
              Number.isInteger(tab.id) &&
              typeof tab.request === 'string' &&
              typeof tab.url === 'string',
          )
        ) {
          setIntruderTabs(
            saved.intruderTabs.map((tab) => {
              const base = newIntruderTab(tab.id)
              // Prefer the new multi-set shape; fall back to migrating an older
              // single `config`/`payloads` tab into one payload set.
              const rawConfigs = Array.isArray(tab.configs)
                ? tab.configs
                : [
                    {
                      ...(tab.config && typeof tab.config === 'object' ? tab.config : {}),
                      list:
                        tab.config && typeof tab.config.list === 'string'
                          ? tab.config.list
                          : typeof tab.payloads === 'string'
                            ? tab.payloads
                            : '',
                    },
                  ]
              const configs = rawConfigs.map((c) => {
                const merged = {
                  ...defaultPayloadConfig(),
                  ...(c && typeof c === 'object' ? c : {}),
                }
                // Older saved tabs used 0 as the random-count default. A
                // random number payload must produce a useful batch.
                if (merged.numberType === 'Random' && (!Number.isFinite(merged.howMany) || merged.howMany < 1)) {
                  merged.howMany = 10
                }
                return merged
              })
              const attackType: AttackType = ATTACK_TYPES.some((a) => a.value === tab.attackType)
                ? (tab.attackType as AttackType)
                : base.attackType
              return {
                ...base,
                id: tab.id,
                name: typeof tab.name === 'string' ? tab.name : base.name,
                url: tab.url,
                request: tab.request,
                attackType,
                concurrency:
                  typeof tab.concurrency === 'number' &&
                  Number.isInteger(tab.concurrency) &&
                  tab.concurrency >= 1
                    ? Math.min(64, tab.concurrency)
                    : base.concurrency,
                configs: configs.length ? configs : [defaultPayloadConfig()],
                results: [],
              }
            }),
          )
          setActiveIntruderTab(saved.intruderTabs[0].id)
          intruderSequence.current = Math.max(...saved.intruderTabs.map((tab) => tab.id))
        }
        if (saved.port && saved.port >= 1024 && saved.port <= 65535) setPort(saved.port)
        if (typeof saved.verifyTLS === 'boolean') setVerifyTLS(saved.verifyTLS)
        setSessionLoaded(true)
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [online])
  useEffect(() => {
    if (!sessionLoaded) return
    const timer = setTimeout(() => {
      void run(() =>
        api.request('workspace.save', {
          tabs: tabs.map(({ id, name, url, request, history, historyIndex }) => ({
            id,
            name,
            url,
            request,
            history,
            historyIndex,
          })),
          groups,
          intruderTabs: intruderTabs.map(({ id, name, url, request, attackType, concurrency, configs }) => ({
            id,
            name,
            url,
            request,
            attackType,
            concurrency,
            configs,
          })),
          port,
          verifyTLS,
        }),
      )
    }, 350)
    return () => clearTimeout(timer)
  }, [tabs, groups, intruderTabs, port, verifyTLS, sessionLoaded, run])
  useEffect(() => {
    let alive = true
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'changed' || event.type === 'ready') {
        setOnline(true)
        refresh(event.data)
      } else {
        setOnline(false)
        setError(event.message)
      }
    })
    api
      .request<EngineState | null>('state')
      .then((next) => {
        if (!alive) return
        if (!next) return
        setOnline(true)
        refresh(next)
        setPort(next.port)
        setInclude(next.scope.include.join('\n'))
        setExclude(next.scope.exclude.join('\n'))
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setConnecting(false)
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [refresh])
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query)
      setPage(0)
    }, 180)
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilters(filters)
      setPage(0)
    }, 200)
    return () => clearTimeout(timer)
  }, [filters])
  useEffect(() => {
    if (!online || view !== 'Proxy' || proxyView !== 'History') return
    let alive = true
    const requestSequence = ++historyRequestSequence.current
    api
      .request<{ items: Flow[]; total: number; unfiltered: number }>('history.list', {
        query: debouncedQuery,
        offset: page * 100,
        limit: 100,
        filter: historyFilterPayload(debouncedFilters),
        sort_by: historySort.key,
        sort_direction: historySort.direction,
      })
      .then((result) => {
        if (result && alive && requestSequence === historyRequestSequence.current) {
          setFlows(result.items)
          setTotal(result.total)
          setUnfilteredTotal(result.unfiltered)
          if (!result.items.length && page > 0) setPage(0)
        }
      })
      .catch((e) => {
        if (alive && requestSequence === historyRequestSequence.current) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [online, revision, view, proxyView, debouncedQuery, page, debouncedFilters, historySort])
  useEffect(() => {
    setScrollTop(0)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [page, debouncedQuery, debouncedFilters])
  useEffect(() => {
    if (!online || view !== 'Proxy' || proxyView !== 'History' || !selectedId) return
    let alive = true
    api
      .request<Detail>('history.detail', { flow_id: selectedId })
      .then((detail) => {
        if (alive && detail) setSelected(detail)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [online, revision, selectedId, view, proxyView])
  useEffect(() => {
    if (!online || view !== 'Proxy' || proxyView !== 'Intercept' || !pending) {
      setInterceptDetail(null)
      return
    }
    let alive = true
    setInterceptDetail(null)
    setInterceptText('')
    api
      .request<Detail>('history.detail', { flow_id: pending.flow_id })
      .then((detail) => {
        if (alive && detail) {
          const text = pending.phase === 'response' ? detail.response : detail.request
          setInterceptText(text)
          setInterceptOriginal(text)
          setInterceptDetail(detail)
        }
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [online, view, proxyView, pending?.flow_id, pending?.phase])
  useEffect(() => {
    if (!online) return
    if (view === 'Live audit')
      void run(async () => {
        const findings = await api.request<Finding[] | null>('audit.list')
        if (findings) setFindings(findings)
      })
    if (view === 'Intruder' && intruderRunningIds.length) {
      const requestSequence = ++intruderResultsSequence.current
      void run(async () => {
        const snapshots = await Promise.all(
          intruderRunningIds.map(async (tabId) => {
            const tab = intruderTabs.find((item) => item.id === tabId)
            if (!tab?.attackId) return null
            const result = await api.request<{ items: JobResult[]; state?: string } | null>(
              'intruder.results',
              { attack_id: tab.attackId },
            )
            return { tabId, result }
          }),
        )
        // Multiple change events can overlap result requests. Only the newest
        // snapshot may update the table; otherwise an older partial response
        // can overwrite the completed run (for example 13 of 20 rows).
        if (requestSequence !== intruderResultsSequence.current) return
        setIntruderTabs((prev) =>
          prev.map((tab) => {
            const snapshot = snapshots.find((item) => item?.tabId === tab.id)?.result
            if (!snapshot) return tab
            return {
              ...tab,
              results: snapshot.items,
              runState: snapshot.state === 'running' ? 'running' : snapshot.state === 'queued' ? 'queued' : snapshot.state === 'cancelled' ? 'cancelled' : 'complete',
            }
          }),
        )
        const stillRunning = snapshots
          .filter((item): item is { tabId: number; result: { items: JobResult[]; state?: string } } => Boolean(item?.result))
          .filter((item) => item.result.state === 'running' || item.result.state === 'queued')
          .map((item) => item.tabId)
        setIntruderRunningIds((current) =>
          current.length === stillRunning.length && current.every((id, index) => id === stillRunning[index])
            ? current
            : stillRunning,
        )
      })
    }
    if (view === 'Collaborator')
      void run(async () => {
        const result = await api.request<{
          items: OastInteraction[]
          status: OastStatus
        } | null>('collaborator.interactions')
        if (!result) return
        setOastInteractions(result.items)
        setOastStatus(result.status)
      })
  }, [view, online, revision, run, intruderRunningIds])
  useEffect(() => {
    if (!online || view !== 'Collaborator' || oastServers.length) return
    void run(async () => {
      const result = await api.request<{ servers: string[]; status: OastStatus } | null>(
        'collaborator.servers',
      )
      if (!result) return
      setOastServers(result.servers)
      setOastStatus(result.status)
      setOastServer((prev) => prev || result.status.server || result.servers[0] || '')
    })
  }, [online, view, run, oastServers.length])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('bidoytu.theme', theme)
    } catch {
      // Ignore storage failures; theme still applies for this session.
    }
  }, [theme])
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      // Scope Ctrl/Cmd+A to the box in focus. Inside a text field the browser
      // already selects only that field. Inside a read-only viewer we select
      // just that region's contents; everywhere else select-all is suppressed
      // so it can't sweep the whole page.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.shiftKey) {
        const active = document.activeElement as HTMLElement | null
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
          return
        }
        const anchor =
          active ?? (window.getSelection()?.anchorNode as Node | null)?.parentElement ?? null
        const region = anchor
          ? (anchor.closest('.code-view, .hex-view') as HTMLElement | null)
          : null
        e.preventDefault()
        if (region) {
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(region)
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setView('Proxy')
        setProxyView('History')
        setTimeout(() => searchRef.current?.focus(), 0)
      }
      if ((e.ctrlKey || e.metaKey) && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        if (e.key === '1') {
          setView('Proxy')
          setProxyView('History')
        } else if (e.key === '2') {
          setView('Proxy')
          setProxyView('Intercept')
        } else if (e.key === '3') setView('Repeater')
        else if (e.key === '4') setView('Intruder')
      }
      // Ctrl+R -> Send to Repeater. Inside Repeater it duplicates the active
      // request into a new tab; inside Intruder it forwards the attack template.
      // Everywhere else it uses the selected history request or the paused
      // intercepted flow. Ctrl+I mirrors this for Intruder.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !e.shiftKey) {
        e.preventDefault()
        if (viewRef.current === 'Repeater') duplicateRepeaterTab()
        else if (viewRef.current === 'Intruder') intruderToRepeater()
        else {
          const detail =
            viewRef.current === 'Proxy' && proxyView === 'Intercept'
              ? interceptDetailRef.current
              : selectedRef.current
          if (detail) toRepeater(detail)
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i' && !e.shiftKey) {
        e.preventDefault()
        if (viewRef.current === 'Intruder') duplicateIntruderTab()
        else if (viewRef.current === 'Repeater') repeaterToIntruder()
        else {
          const detail =
            viewRef.current === 'Proxy' && proxyView === 'Intercept'
              ? interceptDetailRef.current
              : selectedRef.current
          if (detail) toIntruder(detail)
        }
      }
      if (e.key === 'Escape') {
        setShowHelp(false)
        setError('')
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [proxyView])

  async function selectFlow(flowId: string) {
    const sequence = ++detailSequence.current
    setSelectedId(flowId)
    setSelected(null)
    setLoadingDetail(true)
    await run(async () => {
      const detail = await api.request<Detail>('history.detail', { flow_id: flowId })
      if (sequence === detailSequence.current) setSelected(detail)
    })
    if (sequence === detailSequence.current) setLoadingDetail(false)
  }
  function toRepeater(detail: Detail) {
    if (detail.truncated || detail.binary) {
      setError(
        'Binary or truncated previews cannot be replayed as text. Create a new text request.',
      )
      return
    }
    const id = ++tabSequence.current
    setTabs((prev) => [
      ...prev,
      {
        id,
        name: detail.host,
        url: `${detail.scheme}://${detail.host}:${detail.port}`,
        request: detail.request,
        busy: false,
      },
    ])
    setActiveTab(id)
    setView('Repeater')
  }
  function addIntruderTab(seed: Partial<IntruderTab>) {
    const id = ++intruderSequence.current
    setIntruderTabs((prev) => [
      ...prev,
      { ...newIntruderTab(id), ...seed, id, attackId: undefined, runState: 'idle', results: [] },
    ])
    setActiveIntruderTab(id)
    setView('Intruder')
  }
  function toIntruder(detail: Detail) {
    if (detail.truncated || detail.binary) {
      setError('Binary or truncated previews cannot be sent to Intruder as text.')
      return
    }
    addIntruderTab({
      name: detail.host,
      url: `${detail.scheme}://${detail.host}:${detail.port}`,
      request: detail.request,
    })
  }
  // The shortcuts below only read refs and stable setters so the empty-deps
  // keyboard listener always sees the current tab.
  function duplicateRepeaterTab() {
    const current = requestTabRef.current
    if (!current) return
    const id = ++tabSequence.current
    setTabs((prev) => [
      ...prev,
      {
        ...current,
        id,
        name: nextRepeaterCopyName(current.name, prev),
        busy: false,
        result: undefined,
        error: undefined,
        history: [],
        historyIndex: undefined,
      },
    ])
    setActiveTab(id)
    setView('Repeater')
  }
  function duplicateIntruderTab() {
    const current = intruderTabRef.current
    if (!current) return
    const id = ++intruderSequence.current
    setIntruderTabs((prev) => [
      ...prev,
      {
        ...current,
        id,
        name: nextIntruderCopyName(current.name, prev),
        attackId: undefined,
        runState: 'idle',
        results: [],
      },
    ])
    setActiveIntruderTab(id)
    setView('Intruder')
  }
  function repeaterToIntruder() {
    const current = requestTabRef.current
    if (!current) return
    addIntruderTab({ name: current.name, url: current.url, request: current.request })
  }
  function intruderToRepeater() {
    const current = intruderTabRef.current
    if (!current) return
    const id = ++tabSequence.current
    setTabs((prev) => [
      ...prev,
      { id, name: current.name, url: current.url, request: current.request, busy: false },
    ])
    setActiveTab(id)
    setView('Repeater')
  }
  function updateTab(patch: Partial<RepeaterTab>, id = activeTab) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }
  function updateIntruderTab(patch: Partial<IntruderTab>, id = activeIntruderTab) {
    setIntruderTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }
  async function sendRequestForTab(id: number, run = sendRun.current) {
    const tab = tabs.find((item) => item.id === id)
    if (!tab || tab.busy) return
    updateTab({ busy: true, error: undefined, result: undefined, response: undefined }, tab.id)
    try {
      const result = await api.request<Detail>('repeater.send', {
        url: tab.url,
        request: tab.request,
        verify_tls: verifyTLS,
      })
      if (run === sendRun.current) {
        setTabs((prev) =>
          prev.map((item) => {
            if (item.id !== tab.id) return item
            const history = item.history ?? []
            const index = item.historyIndex ?? history.length - 1
            const nextHistory = [...history.slice(0, index + 1), { request: tab.request, result }]
            return {
              ...item,
              response: result.response,
              result,
              history: nextHistory,
              historyIndex: nextHistory.length - 1,
            }
          }),
        )
      }
    } catch (e) {
      if (run === sendRun.current)
        updateTab({ error: e instanceof Error ? e.message : String(e) }, tab.id)
    } finally {
      if (run === sendRun.current) updateTab({ busy: false }, tab.id)
    }
  }
  async function sendRequest() {
    const tab = requestTab
    if (tab?.busy) return
    await sendRequestForTab(tab.id)
  }
  async function sendGroup(
    tabIds: number[],
    mode: 'sequence-single' | 'sequence-separate' | 'parallel',
  ) {
    const run = ++sendRun.current
    if (mode === 'parallel') {
      await Promise.all(tabIds.map((id) => sendRequestForTab(id, run)))
      return
    }
    for (const id of tabIds) {
      if (run !== sendRun.current) return
      await sendRequestForTab(id, run)
    }
  }
  function cancelRequest() {
    ++sendRun.current
    setTabs((prev) => prev.map((tab) => (tab.busy ? { ...tab, busy: false } : tab)))
  }
  function navigateRepeaterHistory(delta: -1 | 1) {
    const tab = requestTab
    const history = tab.history ?? []
    if (history.length < 2) return
    const currentIndex = tab.historyIndex ?? history.length - 1
    const nextIndex = Math.max(0, Math.min(history.length - 1, currentIndex + delta))
    if (nextIndex === currentIndex) return
    const revision = history[nextIndex]
    updateTab(
      {
        request: revision.request,
        response: revision.result.response,
        result: revision.result,
        historyIndex: nextIndex,
      },
      tab.id,
    )
  }
  function setAttackRequest(value: string) {
    updateIntruderTab({ request: value })
  }
  function setAttackUrl(value: string) {
    updateIntruderTab({ url: value })
  }
  function setAttackType(attackType: AttackType) {
    const positions = countPayloadPositions(intruderTab.request)
    updateIntruderTab({
      attackType,
      configs: reconcileConfigs(intruderTab.configs, attackType, positions),
    })
  }
  async function navigateHistory(delta: -1 | 1) {
    if (!flows.length) return
    const current = selectedId ? flows.findIndex((flow) => flow.flow_id === selectedId) : -1
    const localTarget = current < 0 ? (delta > 0 ? 0 : flows.length - 1) : current + delta
    if (localTarget >= 0 && localTarget < flows.length) {
      await selectFlow(flows[localTarget].flow_id)
      return
    }
    const nextPage = page + (delta < 0 ? -1 : 1)
    if (nextPage < 0 || nextPage * 100 >= total) return
    const result = await run(() =>
      api.request<{ items: Flow[]; total: number; unfiltered: number }>('history.list', {
        query: debouncedQuery,
        offset: nextPage * 100,
        limit: 100,
        filter: historyFilterPayload(debouncedFilters),
        sort_by: historySort.key,
        sort_direction: historySort.direction,
      }),
    )
    if (!result?.items?.length) return
    setPage(nextPage)
    setFlows(result.items)
    setTotal(result.total)
    setUnfilteredTotal(result.unfiltered)
    await selectFlow(delta < 0 ? result.items[result.items.length - 1].flow_id : result.items[0].flow_id)
  }
  function setIntruderConcurrency(value: number) {
    updateIntruderTab({ concurrency: Math.max(1, Math.min(64, Math.round(value) || 1)) })
  }
  // Patch the payload-set config at `index` (which position/set is being
  // edited). Reconciles the set list first so the index is always valid.
  function setPayloadConfig(patch: Partial<PayloadConfig>, index = 0) {
    const positions = countPayloadPositions(intruderTab.request)
    const configs = reconcileConfigs(intruderTab.configs, intruderTab.attackType, positions)
    const next = configs.map((config, i) => (i === index ? { ...config, ...patch } : config))
    updateIntruderTab({ configs: next })
  }
  function setResults(value: JobResult[]) {
    updateIntruderTab({ results: value })
  }
  // Wrap the current selection in the request template with the payload
  // marker. Falls back to inserting an empty marker at the caret when nothing
  // is selected.
  function addPayloadPoint(start: number, end: number) {
    const request = intruderTab.request
    const before = request.slice(0, start)
    const selected = request.slice(start, end)
    const after = request.slice(end)
    updateIntruderTab({ request: `${before}§${selected}§${after}` })
  }
  function clearPayloadPoints() {
    updateIntruderTab({ request: intruderTab.request.replace(/§([^§]*)§/g, '$1') })
  }
  async function startIntruder() {
    const tab = intruderTab
    const positions = countPayloadPositions(tab.request)
    if (positions === 0) {
      setError('Mark at least one payload position with § before starting a run.')
      return
    }
    // Build one materialised payload set per position the attack needs. Sniper
    // and battering ram only use the first set.
    const needed = payloadSetCount(tab.attackType, positions)
    const configs = reconcileConfigs(tab.configs, tab.attackType, positions).slice(0, needed)
    const sets = configs.map((config) => generatePayloads(config))
    const emptyAt = sets.findIndex((values) => values.length === 0)
    if (emptyAt !== -1) {
      setError(
        needed === 1
          ? 'Add at least one payload value before starting a run.'
          : `Payload set ${emptyAt + 1} is empty. Add at least one value to every set.`,
      )
      return
    }
    try {
      const started = await api.request<{ attack_id: string }>('intruder.start', {
        url: tab.url,
        request: tab.request,
        attack_type: tab.attackType,
        sets,
        concurrency: tab.concurrency,
        verify_tls: verifyTLS,
      })
      if (!started?.attack_id) throw new Error('Intruder backend did not return an attack id')
      updateIntruderTab(
        { attackId: started.attack_id, runState: 'running', results: [] },
        tab.id,
      )
      setIntruderRunningIds((current) => [...new Set([...current, tab.id])])
      setRunTabId(tab.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    setState((s) => ({ ...s, job_state: 'running' }))
    setRunSelectedIndex(null)
    setRunDetail(null)
    setShowIntruderRun(true)
  }
  async function cancelIntruder(tabId = activeIntruderTab) {
    const tab = intruderTabs.find((item) => item.id === tabId)
    if (!tab?.attackId) return
    await run(async () => {
      await api.request('intruder.cancel', { attack_id: tab.attackId })
      updateIntruderTab({ runState: 'cancelled' }, tabId)
      setIntruderRunningIds((current) => current.filter((id) => id !== tabId))
      setState((s) => ({ ...s, job_state: 'idle' }))
    })
  }
  function openIntruderResults(tabId: number) {
    const tab = intruderTabs.find((item) => item.id === tabId)
    if (!tab) return
    setRunTabId(tabId)
    setRunDetail(null)
    setShowIntruderRun(true)
    const first = tab.results[0]
    setRunSelectedIndex(first?.index ?? null)
    if (first) void selectRunResult(first)
  }
  async function registerOast() {
    if (!oastServer) {
      setError('Choose an OAST server before registering.')
      return
    }
    setOastBusy(true)
    await run(async () => {
      const status = await api.request<OastStatus>('collaborator.register', {
        server: oastServer,
        token: oastToken,
      })
      setOastStatus(status)
      setOastInteractions([])
      setNotice(`Registered with ${status.server}`)
    })
    setOastBusy(false)
  }
  async function generateOastDomain() {
    setOastBusy(true)
    await run(async () => {
      await api.request('collaborator.generate')
      const result = await api.request<{ items: OastInteraction[]; status: OastStatus }>(
        'collaborator.interactions',
      )
      setOastInteractions(result.items)
      setOastStatus(result.status)
      const domain = result.status.domains[0]?.domain
      if (domain) {
        setOastSelected(domain)
        void api.copyText(domain)
        setNotice('Copied new OAST domain to clipboard')
      }
    })
    setOastBusy(false)
  }
  async function pollOastNow() {
    setOastBusy(true)
    await run(async () => {
      await api.request('collaborator.poll')
      const result = await api.request<{ items: OastInteraction[]; status: OastStatus }>(
        'collaborator.interactions',
      )
      setOastInteractions(result.items)
      setOastStatus(result.status)
    })
    setOastBusy(false)
  }
  async function clearOastInteractions() {
    await run(async () => {
      const status = await api.request<OastStatus>('collaborator.clear')
      setOastStatus(status)
      setOastInteractions([])
    })
  }
  async function stopOast() {
    setOastBusy(true)
    await run(async () => {
      const status = await api.request<OastStatus>('collaborator.stop')
      setOastStatus(status)
      setOastInteractions([])
      setOastSelected(null)
    })
    setOastBusy(false)
  }
  // Load a single result's request/response for the run popup, mirroring the
  // history detail behaviour.
  async function selectRunResult(result: JobResult) {
    setRunSelectedIndex(result.index)
    if (!result.flow_id) {
      setRunDetail(null)
      return
    }
    const sequence = ++runDetailSequence.current
    setRunDetail(null)
    setRunDetailLoading(true)
    await run(async () => {
      const detail = await api.request<Detail>('history.detail', { flow_id: result.flow_id })
      if (sequence === runDetailSequence.current) setRunDetail(detail)
    })
    if (sequence === runDetailSequence.current) setRunDetailLoading(false)
  }
  async function toggleProxy() {
    setBusy(true)
    await run(async () =>
      refresh(
        await api.request<EngineState>(state.running ? 'proxy.stop' : 'proxy.start', {
          port,
          verify_tls: verifyTLS,
        }),
      ),
    )
    setBusy(false)
  }
  async function interceptToggle(enabled = !state.intercept, responses = state.responses) {
    await run(async () =>
      refresh(await api.request<EngineState>('proxy.intercept', { enabled, responses })),
    )
  }
  async function resolveIntercept(drop: boolean) {
    if (!pending) return
    setBusy(true)
    await run(async () =>
      refresh(
        await api.request<EngineState>('proxy.resolve', {
          flow_id: pending.flow_id,
          drop,
          ...(interceptText !== interceptOriginal ? { edited_text: interceptText } : {}),
        }),
      ),
    )
    setBusy(false)
  }
  async function resolveAllIntercept(drop: boolean) {
    if (state.pending.length === 0) return
    setBusy(true)
    const waiting = [...state.pending]
    await run(async () => {
      let next = state
      for (const item of waiting) {
        next = await api.request<EngineState>('proxy.resolve', {
          flow_id: item.flow_id,
          drop,
          ...(item.flow_id === pending?.flow_id && interceptText !== interceptOriginal
            ? { edited_text: interceptText }
            : {}),
        })
        refresh(next)
      }
      return next
    })
    setBusy(false)
  }
  function resize(e: React.PointerEvent) {
    const element = e.currentTarget as HTMLElement
    element.setPointerCapture(e.pointerId)
    const move = (event: PointerEvent) => {
      const rect = historyRef.current!.getBoundingClientRect()
      setSplit(Math.min(72, Math.max(25, ((event.clientY - rect.top) / rect.height) * 100)))
    }
    const stop = () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
  }
  function resizeIntercept(e: React.PointerEvent) {
    const element = e.currentTarget as HTMLElement
    element.setPointerCapture(e.pointerId)
    const move = (event: PointerEvent) => {
      const rect = interceptRef.current!.getBoundingClientRect()
      setInterceptSplit(
        Math.min(78, Math.max(22, ((event.clientY - rect.top) / rect.height) * 100)),
      )
    }
    const stop = () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
  }

  const trafficStart = Math.max(0, Math.floor(scrollTop / 24) - 5)
  const visibleTraffic = flows.slice(trafficStart, trafficStart + 50)
  const Icon = icons[view]
  return {
    view,
    setView,
    proxyView,
    setProxyView,
    state,
    setState,
    online,
    setOnline,
    connecting,
    setConnecting,
    error,
    setError,
    notice,
    setNotice,
    busy,
    setBusy,
    revision,
    setRevision,
    flows,
    setFlows,
    total,
    setTotal,
    unfilteredTotal,
    query,
    setQuery,
    debouncedQuery,
    setDebouncedQuery,
    filters,
    setFilters,
    debouncedFilters,
    updateFilters,
    resetFilters,
    activeFilterCount,
    showFilters,
    setShowFilters,
    historySort,
    setHistorySort,
    clearHistory,
    page,
    setPage,
    selected,
    setSelected,
    loadingDetail,
    setLoadingDetail,
    selectedId,
    setSelectedId,
    port,
    setPort,
    verifyTLS,
    setVerifyTLS,
    tabs,
    setTabs,
    groups,
    setGroups,
    activeTab,
    setActiveTab,
    tabSequence,
    interceptText,
    setInterceptText,
    interceptOriginal,
    setInterceptOriginal,
    interceptId,
    setInterceptId,
    interceptDetail,
    setInterceptDetail,
    include,
    setInclude,
    exclude,
    setExclude,
    findings,
    setFindings,
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
    decoderInput,
    setDecoderInput,
    decoderOutput,
    setDecoderOutput,
    operation,
    setOperation,
    attackRequest: intruderTab.request,
    setAttackRequest,
    attackUrl: intruderTab.url,
    setAttackUrl,
    attackType: intruderTab.attackType,
    concurrency: intruderTab.concurrency,
    setAttackType,
    setIntruderConcurrency,
    // Configs reconciled to the current attack type + position count, so the
    // view always sees exactly the payload sets it should render.
    payloadConfigs: reconcileConfigs(
      intruderTab.configs,
      intruderTab.attackType,
      countPayloadPositions(intruderTab.request),
    ),
    setPayloadConfig,
    addPayloadPoint,
    clearPayloadPoints,
    payloadPositions: countPayloadPositions(intruderTab.request),
    // Total requests the current configuration will send.
    intruderRequestCount: intruderRequestCount(intruderTab),
    results: intruderTab.results,
    setResults,
    intruderTabs,
    setIntruderTabs,
    activeIntruderTab,
    setActiveIntruderTab,
    intruderSequence,
    intruderTab,
    intruderRunningIds,
    runTabId,
    intruderRunTab,
    updateIntruderTab,
    startIntruder,
    duplicateIntruderTab,
    repeaterToIntruder,
    showIntruderRun,
    setShowIntruderRun,
    runSelectedIndex,
    runDetail,
    runDetailLoading,
    selectRunResult,
    cancelIntruder,
    openIntruderResults,
    showHelp,
    setShowHelp,
    theme,
    setTheme,
    searchRef,
    detailSequence,
    scrollRef,
    scrollTop,
    setScrollTop,
    split,
    setSplit,
    interceptSplit,
    setInterceptSplit,
    sessionLoaded,
    setSessionLoaded,
    historyRef,
    interceptRef,
    requestTab,
    pending,
    run,
    refresh,
    trafficStart,
    visibleTraffic,
    Icon,
    selectFlow,
    navigateHistory,
    toRepeater,
    toIntruder,
    updateTab,
    duplicateRepeaterTab,
    intruderToRepeater,
    sendRequest,
    sendGroup,
    cancelRequest,
    navigateRepeaterHistory,
    toggleProxy,
    interceptToggle,
    resolveIntercept,
    resolveAllIntercept,
    resize,
    resizeIntercept,
  }
}
export type WorkspaceController = ReturnType<typeof useWorkspace>

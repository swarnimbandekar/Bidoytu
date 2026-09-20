import { useRef } from 'react'
import {
  ArrowRight,
  Bookmark,
  Crosshair,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Radio,
  Search,
  SlidersHorizontal,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Trash2,
} from 'lucide-react'
import { api } from '../api'
import {
  Button,
  ContextMenu,
  Editor,
  Empty,
  Status,
  bytes,
  duration,
  useContextMenu,
} from '../components'
import { HistoryFilterModal } from './HistoryFilterModal'

import type { WorkspaceController } from '../hooks/useWorkspace'

export function HistoryView({ workspace }: { workspace: WorkspaceController }) {
  const {
    state,
    setRevision,
    flows,
    total,
    unfilteredTotal,
    query,
    setQuery,
    filters,
    updateFilters,
    resetFilters,
    activeFilterCount,
    showFilters,
    setShowFilters,
    historySort,
    setHistorySort,
    clearHistory,
    selected,
    setSelected,
    loadingDetail,
    selectedId,
    port,
    setShowHelp,
    searchRef,
    scrollRef,
    scrollTop,
    setScrollTop,
    split,
    setSplit,
    historyRef,
    run,
    trafficStart,
    visibleTraffic,
    selectFlow,
    navigateHistory,
    toRepeater,
    toIntruder,
    resize,
  } = workspace
  const ctx = useContextMenu()
  const lastVirtualRow = useRef(-1)
  const sortHeader = (key: typeof historySort.key, label: string) => {
    const active = historySort.key === key
    const SortIcon = active ? (historySort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
    return (
      <button
        className={active ? 'sort-header active' : 'sort-header'}
        onClick={() =>
          setHistorySort((current) => ({
            key,
            direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
          }))
        }
      >
        <span>{label}</span>
        <SortIcon size={11} />
      </button>
    )
  }
  return (
    <div
      className="history-workspace"
      ref={historyRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        void navigateHistory(event.key === 'ArrowUp' ? -1 : 1)
      }}
      style={{ gridTemplateRows: `${split}% 7px minmax(0, 1fr)` }}
    >
      <section className="traffic-panel">
        <div className="traffic-toolbar">
          <label className="search-box">
            <Search size={15} />
            <input
              ref={searchRef}
              aria-label="Search traffic"
              placeholder="Filter by host, path, method, or status…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>Ctrl K</kbd>
          </label>
          <Button
            className={filters.inScopeOnly ? 'selected' : 'subtle'}
            aria-pressed={filters.inScopeOnly}
            onClick={() => updateFilters({ inScopeOnly: !filters.inScopeOnly })}
          >
            <Crosshair size={14} />
            In scope
          </Button>
          <Button
            title="Show bookmarked traffic"
            aria-label="Show bookmarked traffic"
            aria-pressed={filters.bookmarkedOnly}
            className={filters.bookmarkedOnly ? 'selected icon-only' : 'subtle icon-only'}
            onClick={() => updateFilters({ bookmarkedOnly: !filters.bookmarkedOnly })}
          >
            <Bookmark size={14} />
          </Button>
          <Button
            className={showFilters || activeFilterCount ? 'selected' : 'subtle'}
            aria-haspopup="dialog"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal size={14} />
            Filters
            {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
          </Button>
          <Button
            className="subtle"
            title="Clear all HTTP history"
            onClick={() => {
              if (window.confirm('Clear all HTTP history? This cannot be undone.'))
                void clearHistory()
            }}
          >
            <Trash2 size={14} />
            Clear history
          </Button>
        </div>
        <div className="traffic-header traffic-row">
          {sortHeader('id', '#')}
          {sortHeader('method', 'Method')}
          {sortHeader('host', 'Host')}
          {sortHeader('path', 'Path')}
          {sortHeader('status', 'Status')}
          {sortHeader('size', 'Size')}
          {sortHeader('time', 'Time')}
          <span />
        </div>
        <div
          className="traffic-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            // Keep virtual scrolling local to a row boundary. Updating the
            // workspace state for every pixel used to re-render the complete
            // shell while users scanned history.
            const row = Math.floor(e.currentTarget.scrollTop / 24)
            if (row === lastVirtualRow.current) return
            lastVirtualRow.current = row
            setScrollTop(row * 24)
          }}
        >
          {flows.length ? (
            <div style={{ height: flows.length * 24, position: 'relative' }}>
              <div style={{ position: 'absolute', top: trafficStart * 24, left: 0, right: 0 }}>
                {visibleTraffic.map((flow) => (
                  <button
                    className={`traffic-row ${selectedId === flow.flow_id ? 'selected-row' : ''}`}
                    key={flow.flow_id}
                    onClick={() => void selectFlow(flow.flow_id)}
                    onContextMenu={(e) => {
                      void selectFlow(flow.flow_id)
                      ctx.open(e, [
                        {
                          label: 'Send to Repeater',
                          shortcut: 'Ctrl+R',
                          onClick: async () => {
                            const detail = await api.request<import('../types').Detail>(
                              'history.detail',
                              { flow_id: flow.flow_id },
                            )
                            toRepeater(detail)
                          },
                        },
                        {
                          label: 'Send to Intruder',
                          shortcut: 'Ctrl+I',
                          onClick: async () => {
                            const detail = await api.request<import('../types').Detail>(
                              'history.detail',
                              { flow_id: flow.flow_id },
                            )
                            toIntruder(detail)
                          },
                        },
                        {
                          label: 'Clear all history',
                          onClick: () => {
                            if (window.confirm('Clear all HTTP history? This cannot be undone.'))
                              void clearHistory()
                          },
                        },
                      ])
                    }}
                  >
                    <span className="muted mono">{flow.id}</span>
                    <span className={`method method-${flow.method.toLowerCase()}`}>
                      {flow.method}
                    </span>
                    <span className="host-cell">
                      {flow.scheme === 'https' ? <LockKeyhole size={11} /> : <Globe2 size={11} />}
                      <span>{flow.host}</span>
                    </span>
                    <span className="mono path-cell" title={flow.path}>
                      {flow.path}
                    </span>
                    <span>
                      <Status value={flow.status_code} />
                    </span>
                    <span className="muted mono">{bytes(flow.response_body_size)}</span>
                    <span className="muted mono">{duration(flow.duration_ms)}</span>
                    <span className="row-mark">
                      {flow.bookmarked ? (
                        <Bookmark size={12} />
                      ) : flow.scope ? (
                        <span className="scope-dot" />
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Empty
              icon={<Radio size={28} />}
              title={
                query || activeFilterCount
                  ? 'No matching requests'
                  : 'Your next discovery starts here'
              }
            >
              {query || activeFilterCount ? (
                'Try another search or turn off the active filters.'
              ) : (
                <>
                  Start the proxy and route your browser through <code>127.0.0.1:{state.port}</code>
                  .<br />
                  Captured traffic will appear here in real time.
                  <button className="text-button" onClick={() => setShowHelp(true)}>
                    Set up your browser <ArrowRight size={13} />
                  </button>
                </>
              )}
            </Empty>
          )}
        </div>
      </section>
      <div
        className="split-handle"
        role="separator"
        aria-label="Resize traffic and inspector"
        aria-valuenow={split}
        aria-valuemin={25}
        aria-valuemax={72}
        tabIndex={0}
        onPointerDown={resize}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setSplit((v) => Math.max(25, v - 3))
          if (e.key === 'ArrowDown') setSplit((v) => Math.min(72, v + 3))
        }}
      >
        <span />
      </div>
      <section className="inspector">
        <div className="inspector-bar">
          <div className="inline">
            <span className="inspector-label">INSPECTOR</span>
            {loadingDetail ? (
              <LoaderCircle size={13} className="spin" />
            ) : selected ? (
              <>
                <span className={`method method-${selected.method.toLowerCase()}`}>
                  {selected.method}
                </span>
                <span className="mono ellipsis">
                  {selected.host}
                  {selected.path}
                </span>
              </>
            ) : (
              <span className="muted">No request selected</span>
            )}
          </div>
          <div className="inline">
            {selected?.truncated && (
              <span className="warning-text">Preview limited to 256 KiB</span>
            )}
            <Button
              className="subtle icon-only"
              aria-label="Bookmark selected request"
              disabled={!selected}
              onClick={() =>
                void run(async () => {
                  if (!selected) return
                  await api.request('history.metadata', {
                    flow_id: selected.flow_id,
                    bookmarked: !selected.bookmarked,
                    notes: selected.notes,
                  })
                  setSelected({ ...selected, bookmarked: !selected.bookmarked })
                  setRevision((v) => v + 1)
                })
              }
            >
              <Bookmark size={13} fill={selected?.bookmarked ? 'currentColor' : 'none'} />
            </Button>
            <Button
              className="subtle"
              disabled={!selected || selected.truncated || selected.binary}
              onClick={() => selected && toRepeater(selected)}
            >
              Send to Repeater <ArrowRight size={13} />
            </Button>
          </div>
        </div>
        <div
          className="editor-split"
          onContextMenu={(e) => {
            if (!selected) return
            ctx.open(e, [
              {
                label: 'Send to Repeater',
                shortcut: 'Ctrl+R',
                disabled: !selected || selected.truncated || selected.binary,
                onClick: () => selected && toRepeater(selected),
              },
              {
                label: 'Send to Intruder',
                shortcut: 'Ctrl+I',
                disabled: !selected || selected.truncated || selected.binary,
                onClick: () => selected && toIntruder(selected),
              },
            ])
          }}
        >
          <Editor title="Request" value={selected?.request ?? ''} />
          <Editor
            title="Response"
            value={selected?.response ?? ''}
            hint={
              selected?.status_code
                ? `${selected.status_code} · ${duration(selected.duration_ms)}`
                : undefined
            }
          />
        </div>
      </section>
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
      {showFilters && (
        <HistoryFilterModal
          filters={filters}
          onChange={updateFilters}
          onReset={resetFilters}
          onClose={() => setShowFilters(false)}
          total={total}
          unfiltered={unfilteredTotal}
        />
      )}
    </div>
  )
}

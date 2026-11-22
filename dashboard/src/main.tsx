import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Archive, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, Menu, Moon, Pencil, Plus, Sun, Trash2 } from 'lucide-react'
import { MotionConfig, motion } from 'motion/react'
import { domains, moneyDecimal } from '../../src/shared/records.ts'
import type { AnyEntry, Domain } from '../../src/shared/records.ts'
import { ApiError, request } from './api.ts'
import { DeleteDialog, Editor } from './editor.tsx'
import { auditDate, entryDescription, entryTitle, sections } from './presentation.ts'
import './style.css'

type Page = 'overview' | Domain
type Kind = 'income' | 'expense'
type Overview = { counts: Record<Domain, number>, recent: AnyEntry[], timezone: string, discord: string }
type Dialog = { kind: 'add', financeKind?: Kind } | { kind: 'edit' | 'delete', entry: AnyEntry }
const pageSize = 20
const currencies = Intl.supportedValuesOf('currency')

function currentPage(): Page {
  const hash = location.hash.slice(1) as Domain
  return domains.includes(hash) ? hash : 'overview'
}

function useResource<T>(path: string | undefined, version: number) {
  const [result, setResult] = useState<{ path: string, data?: T, error?: string }>()
  useEffect(() => {
    if (!path) return
    let active = true
    void request<T>(path).then(
      data => { if (active) setResult({ path, data }) },
      reason => { if (active) setResult({ path, error: reason instanceof Error ? reason.message : 'Unable to load records.' }) },
    )
    return () => { active = false }
  }, [path, version])
  return path && result?.path === path ? result : undefined
}

function EntryList({ entries, selected, choose, timezone }: {
  entries: AnyEntry[], selected?: string, choose: (entry: AnyEntry) => void, timezone?: string,
}) {
  return <ul className="record-list">{entries.map(entry => {
    const Icon = sections[entry.domain].icon
    return <li key={entry.id}>
      <button className="record-row" aria-pressed={timezone ? undefined : selected === entry.id} onClick={() => choose(entry)}>
        <span className="row-icon"><Icon size={18} aria-hidden="true" /></span>
        <span className="row-copy"><strong>{entryTitle(entry)}</strong><span>{entryDescription(entry)}</span></span>
        {timezone && <time dateTime={entry.updatedAt}>{auditDate(entry.updatedAt, timezone)}</time>}
        <ChevronRight size={17} className="row-arrow" aria-hidden="true" />
      </button>
    </li>
  })}</ul>
}

function Empty({ title, children }: { title: string, children?: React.ReactNode }) {
  return <div className="empty">
    <span className="empty-icon"><BookOpen size={23} aria-hidden="true" /></span>
    <strong>{title}</strong>
    {children}
  </div>
}

function RecordsPanel({ domain, kind, month, currency, archived, version, selected, choose, add }: {
  domain: Domain, kind?: Kind, month: string, currency: string, archived?: boolean, version: number, selected?: string,
  choose: (entry: AnyEntry) => void, add: () => void,
}) {
  const [offset, setOffset] = useState(0)
  const params = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset) })
  if (kind) params.set('kind', kind)
  if (kind && month) params.set('month', month)
  if (kind && currency) params.set('currency', currency)
  if (archived) params.set('history', 'all')
  const records = useResource<AnyEntry[]>('records/' + domain + '?' + params, version)
  const Icon = kind === 'income' ? ArrowDownLeft : ArrowUpRight
  const entries = records?.data?.slice(0, pageSize)
  return <section className="panel list-panel">
    <div className="panel-header">
      <h2>{kind && <Icon size={18} className="accent-text" aria-hidden="true" />}{kind ? kind === 'income' ? 'Income' : 'Expenses' : 'Entries'}</h2>
      {kind && <button className="icon-button" aria-label={kind === 'income' ? 'Add income' : 'Add expense'} onClick={add}><Plus size={18} /></button>}
    </div>
    {!records && <p className="loading" role="status">Loading entries…</p>}
    {records?.error && <p className="notice danger inset" role="alert">{records.error}</p>}
    {entries && (entries.length
      ? <EntryList entries={entries} selected={selected} choose={choose} />
      : <Empty title={offset || month || currency ? 'No matching entries' : 'No entries yet'}>
        {!offset && <button className="button" onClick={add}><Plus size={16} /> Add {kind ? kind === 'income' ? 'income' : 'expense' : sections[domain].singular}</button>}
      </Empty>)}
    {entries && (!!offset || (records?.data?.length ?? 0) > pageSize) && <div className="pagination">
      <button className="icon-button" onClick={() => setOffset(offset - pageSize)} disabled={!offset} aria-label="Previous page"><ChevronLeft size={18} /></button>
      <span>Page {offset / pageSize + 1}</span>
      <button className="icon-button" onClick={() => setOffset(offset + pageSize)} disabled={(records?.data?.length ?? 0) <= pageSize} aria-label="Next page"><ChevronRight size={18} /></button>
    </div>}
  </section>
}

type DetailRow = [string, string | number | null]
function detailRows(entry: AnyEntry): DetailRow[] {
  switch (entry.domain) {
    case 'profile': return [['Field', entry.data.field], ['Tag', entry.data.tag], ['Status', entry.data.archived ? 'Archived' : 'Current'], ['Description', entry.data.description]]
    case 'diet': return [['Meal date', entry.data.mealDate], ['Estimated calories', entry.data.calories === null ? null : entry.data.calories + ' kcal'], ['Description', entry.data.description]]
    case 'finance': return [['Month', entry.data.month], ['Currency', entry.data.currency], ['Type', entry.data.kind === 'income' ? 'Income' : 'Expenses']]
    case 'workout': return [['Workout date', entry.data.workoutDate], ['Body area', entry.data.part], ['Exercises and sets', entry.data.description]]
    case 'activity': return [['Event date', entry.data.eventDate], ['Approximate time', entry.data.approximateTime], ['Companions', entry.data.withWho], ['Location', entry.data.location], ['Personal note', entry.data.note]]
  }
}

function Details({ entry, timezone, version, choose, edit, remove }: {
  entry: AnyEntry, timezone: string, version: number, choose: (entry: AnyEntry) => void, edit: () => void, remove: () => void,
}) {
  const [showHistory, setShowHistory] = useState(false)
  const [historyOffset, setHistoryOffset] = useState(0)
  const history = useResource<AnyEntry[]>(entry.domain === 'profile' && showHistory
    ? 'records/profile?' + new URLSearchParams({ history: 'all', field: entry.data.field, offset: String(historyOffset), limit: String(pageSize + 1) }) : undefined, version)
  const rows = detailRows(entry)
  return <section className="panel detail-panel" aria-label="Entry details">
    <div className="panel-header">
      <h2>Entry details</h2>
      <div className="action-group">
        <button className="icon-button" aria-label="Edit entry" onClick={edit}><Pencil size={17} /></button>
        <button className="icon-button delete-button" aria-label="Delete entry" onClick={remove}><Trash2 size={17} /></button>
      </div>
    </div>
    <div className="detail-body">
      <h3>{entryTitle(entry)}</h3>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>
      {entry.domain === 'finance' && <section className="finance-detail">
        <h4>Breakdown</h4>
        {entry.data.details.length ? <table>
          <thead><tr><th scope="col">Item</th><th scope="col">Amount</th></tr></thead>
          <tbody>{entry.data.details.map((item, index) => <tr key={index}>
            <td>{item.label}</td>
            <td>{item.amountMinor === null ? '—' : moneyDecimal(item.amountMinor, entry.data.currency)}</td>
          </tr>)}</tbody>
        </table> : <p className="muted">No breakdown recorded.</p>}
      </section>}
      <div className="audit">
        <span>Created <time dateTime={entry.createdAt}>{auditDate(entry.createdAt, timezone)}</time></span>
        <span>Updated <time dateTime={entry.updatedAt}>{auditDate(entry.updatedAt, timezone)}</time></span>
      </div>
      {entry.domain === 'profile' && <button className="button" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}><Archive size={16} /> Field history</button>}
    </div>
    {showHistory && <div className="history">
      {history?.error && <p className="notice danger inset" role="alert">{history.error}</p>}
      {history?.data && <EntryList entries={history.data.slice(0, pageSize)} selected={entry.id} choose={choose} />}
      {!!history?.data && (!!historyOffset || history.data.length > pageSize) && <div className="pagination">
        <button className="icon-button" onClick={() => setHistoryOffset(historyOffset - pageSize)} disabled={!historyOffset} aria-label="Previous history page"><ChevronLeft size={18} /></button>
        <span>Page {historyOffset / pageSize + 1}</span>
        <button className="icon-button" onClick={() => setHistoryOffset(historyOffset + pageSize)} disabled={history.data.length <= pageSize} aria-label="Next history page"><ChevronRight size={18} /></button>
      </div>}
    </div>}
  </section>
}

function App() {
  const [page, setPage] = useState<Page>(currentPage)
  const [menu, setMenu] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('soxin-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  const [version, setVersion] = useState(0)
  const [selection, setSelection] = useState<AnyEntry>()
  const [dialog, setDialog] = useState<Dialog>()
  const [month, setMonth] = useState('')
  const [currency, setCurrency] = useState('')
  const [archived, setArchived] = useState(false)
  const [notice, setNotice] = useState('')
  const stats = useResource<Overview>('overview', version)
  const timezone = stats?.data?.timezone ?? 'UTC'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('soxin-theme', theme)
  }, [theme])
  useEffect(() => {
    const update = () => {
      setPage(currentPage())
      setSelection(undefined)
      setDialog(undefined)
      setMenu(false)
    }
    addEventListener('popstate', update)
    return () => removeEventListener('popstate', update)
  }, [])
  useEffect(() => {
    const interval = setInterval(() => setVersion(value => value + 1), 15000)
    return () => clearInterval(interval)
  }, [])

  function open(target: Page, entry?: AnyEntry, add = false) {
    if (page !== target) history.pushState(null, '', target === 'overview' ? '/' : '#' + target)
    setPage(target)
    setSelection(entry)
    setDialog(add ? { kind: 'add' } : undefined)
    setMenu(false)
    setNotice('')
    setVersion(value => value + 1)
  }

  async function refresh() {
    setVersion(value => value + 1)
    setDialog(undefined)
    if (!selection) return
    try {
      setSelection(await request<AnyEntry>('records/' + selection.domain + '/' + selection.id))
      setNotice('Entry refreshed.')
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setSelection(undefined)
      setNotice(error instanceof Error ? error.message : 'Unable to refresh the entry.')
    }
  }

  const add = (financeKind?: Kind) => setDialog({ kind: 'add', financeKind })
  const discord = stats?.data?.discord
  return <MotionConfig reducedMotion="user">
    <a className="skip-link" href="#main-content" onClick={event => {
      event.preventDefault()
      document.getElementById('main-content')?.focus()
    }}>Skip to content</a>
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span /> <span /><span /></span>
          <div><strong>SoXin</strong><span>Memory dashboard</span></div>
          <button className="icon-button menu-toggle" aria-label="Navigation menu" aria-controls="navigation" aria-expanded={menu} onClick={() => setMenu(!menu)}><Menu size={22} /></button>
        </div>
        <nav id="navigation" aria-label="Memory sections" className={menu ? 'navigation expanded' : 'navigation'}>
          {(['overview', ...domains] as const).map(key => {
            const Icon = sections[key].icon
            return <a key={key} href={key === 'overview' ? '/' : '#' + key} aria-current={page === key ? 'page' : undefined}
              onClick={event => {
                if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
                event.preventDefault()
                open(key)
              }}><Icon size={18} aria-hidden="true" /> {sections[key].label}</a>
          })}
        </nav>
        <div className="rail-footer">
          <span className="workspace-dot" />
          <span>Local workspace</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <h1>{sections[page].label}</h1>
          <div className="action-group">
            <span className="connection"><i className={discord === 'connected' ? 'connected' : undefined} />{discord ? 'Discord ' + discord : 'Checking Discord'}</span>
            <button className="icon-button theme-toggle" aria-label={'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {notice && <p className="notice" role="status">{notice}</p>}
          {page === 'overview' ? <>
            <section aria-labelledby="collections-title">
              <div className="section-bar overview-title"><h2 id="collections-title">Memory collections</h2><span>{stats?.data && Object.values(stats.data.counts).reduce((sum, count) => sum + count, 0) + ' entries'}</span></div>
              {stats?.error && <p className="notice danger" role="alert">{stats.error} <button className="button" onClick={() => void refresh()}>Retry</button></p>}
              <div className="collection-grid">{domains.map(domain => {
                const { icon: Icon, label } = sections[domain]
                const count = stats?.data?.counts[domain]
                return <motion.button key={domain} className="collection" whileHover={{ y: -2 }} transition={{ duration: 0.15 }}
                  onClick={() => open(domain, undefined, count === 0)}>
                  <span className="collection-heading"><span className="collection-icon"><Icon size={19} aria-hidden="true" /></span>{label}</span>
                  <span className="collection-count">{count ?? '—'}</span>
                  <span className="collection-action">{count === 0 ? 'Add first entry' : 'View entries'}<ArrowRight size={15} aria-hidden="true" /></span>
                </motion.button>
              })}</div>
            </section>
            <section className="panel recent-panel">
              <div className="panel-header"><h2>Recent entries</h2>
                {stats?.data?.recent.length ? <span className="muted">Last updated</span> : null}
              </div>
              {!stats && <p className="loading" role="status">Loading entries…</p>}
              {stats?.data && (stats.data.recent.length ? <EntryList entries={stats.data.recent} timezone={timezone} choose={entry => open(entry.domain, entry)} />
                : <Empty title="No recorded memories yet"><p>Choose a collection above to add your first entry.</p></Empty>)}
            </section>
          </> : <>
            <div className="section-bar domain-toolbar">
              {page === 'finance' ? <div className="filters">
                <label>Month <input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
                <label>Currency <select value={currency} onChange={event => setCurrency(event.target.value)}>
                  <option value="">All currencies</option>
                  {currencies.map(code => <option value={code} key={code}>{code}</option>)}
                </select></label>
                {(month || currency) && <button className="button" onClick={() => { setMonth(''); setCurrency('') }}>Clear filters</button>}
              </div> : <div className="filters">
                <span className="muted">{stats?.data ? stats.data.counts[page] + (page === 'profile' ? ' current entries' : ' entries') : ''}</span>
                {page === 'profile' && <label className="inline-filter"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} /> Include archived</label>}
              </div>}
              <button className="button primary" onClick={() => add()}><Plus size={18} /> Add {sections[page].singular}</button>
            </div>
            <div className={'record-layout' + (page === 'finance' ? ' finance-layout' : '') + (selection ? ' showing-detail' : '')}>
              {page === 'finance' ? <div className="finance-grid">{(['income', 'expense'] as const).map(kind =>
                <RecordsPanel key={kind + month + currency} domain={page} kind={kind} month={month} currency={currency}
                  version={version} selected={selection?.id} choose={setSelection} add={() => add(kind)} />)}</div>
                : <RecordsPanel key={page + archived} domain={page} month="" currency="" version={version} archived={page === 'profile' && archived}
                  selected={selection?.id} choose={setSelection} add={() => add()} />}
              {selection && <Details key={selection.domain === 'profile' ? selection.data.field : selection.id}
                entry={selection} timezone={timezone} version={version} choose={setSelection}
                edit={() => { setNotice(''); setDialog({ kind: 'edit', entry: selection }) }}
                remove={() => { setNotice(''); setDialog({ kind: 'delete', entry: selection }) }} />}
            </div>
          </>}
        </main>
      </div>
    </div>
    {dialog && page !== 'overview' && (dialog.kind === 'delete'
      ? <DeleteDialog entry={dialog.entry} close={() => setDialog(undefined)} refresh={refresh}
        deleted={() => { setDialog(undefined); setSelection(undefined); setNotice('Entry deleted.'); setVersion(value => value + 1) }} />
      : <Editor domain={page} entry={dialog.kind === 'edit' ? dialog.entry : undefined} timezone={timezone}
        kind={dialog.kind === 'add' ? dialog.financeKind : undefined} month={month} currency={currency}
        close={() => setDialog(undefined)} refresh={refresh}
        saved={entry => { setDialog(undefined); setSelection(entry); setNotice('Entry saved.'); setVersion(value => value + 1) }} />)}
  </MotionConfig>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

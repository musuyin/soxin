import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { currencySchema, localDay, moneyDecimal, parseMoney, parseRecord } from '../../src/shared/records.ts'
import type { AnyEntry, Domain, RecordData } from '../../src/shared/records.ts'
import { ApiError, request } from './api.ts'
import { entryTitle, sections } from './presentation.ts'

export function Modal({ title, close, children }: { title: string, close: () => void, children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = ref.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); close() }}>
    <header className="dialog-header">
      <h2 id="dialog-title">{title}</h2>
      <button type="button" className="icon-button" aria-label="Close dialog" onClick={close}><X size={20} /></button>
    </header>
    {children}
  </dialog>
}

type Field = { name: string, label: string, type?: 'text' | 'textarea' | 'date' | 'month' | 'checkbox' | 'select', required?: boolean }
const fields: Record<Domain, Field[]> = {
  profile: [
    { name: 'field', label: 'Field', required: true }, { name: 'tag', label: 'Tag', required: true },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'archived', label: 'Archived', type: 'checkbox' },
  ],
  diet: [
    { name: 'mealDate', label: 'Meal date', type: 'date', required: true },
    { name: 'mealType', label: 'Meal type', required: true },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'calories', label: 'Estimated calories (kcal)' },
  ],
  finance: [
    { name: 'kind', label: 'Type', type: 'select', required: true },
    { name: 'month', label: 'Month', type: 'month', required: true },
    { name: 'currency', label: 'Currency code', required: true },
    { name: 'total', label: 'Monthly total', required: true },
  ],
  workout: [
    { name: 'workoutDate', label: 'Workout date', type: 'date', required: true },
    { name: 'part', label: 'Body area', required: true },
    { name: 'description', label: 'Exercises and sets', type: 'textarea', required: true },
  ],
  activity: [
    { name: 'event', label: 'Event', required: true }, { name: 'eventDate', label: 'Event date', type: 'date' },
    { name: 'approximateTime', label: 'Approximate time' }, { name: 'withWho', label: 'Companions' },
    { name: 'location', label: 'Location' }, { name: 'note', label: 'Personal note', type: 'textarea' },
  ],
}

type DetailDraft = { key: number, label: string, amount: string }
type Values = Record<string, string | boolean>
type EditorProps = {
  domain: Domain, entry?: AnyEntry, timezone: string, kind?: 'income' | 'expense', month?: string, currency?: string,
  close: () => void, saved: (entry: AnyEntry) => void, refresh: () => Promise<void>,
}

function initialValues({ domain, entry, timezone, kind, month, currency }: EditorProps) {
  const today = localDay(new Date(), timezone)
  const values: Values = {
    kind: kind ?? 'income', month: month || today.slice(0, 7), currency: currency || 'CNY',
    mealDate: today, workoutDate: today, archived: false,
  }
  if (entry) {
    for (const [key, value] of Object.entries(entry.data)) {
      if (key !== 'details') values[key] = typeof value === 'boolean' ? value : String(value ?? '')
    }
    if (domain === 'finance' && entry.domain === 'finance') values.total = moneyDecimal(entry.data.amountMinor, entry.data.currency)
  }
  return values
}

export function Editor(props: EditorProps) {
  const { domain, entry, close, saved, refresh } = props
  const [values, setValues] = useState(() => initialValues(props))
  const [details, setDetails] = useState<DetailDraft[]>(() => entry?.domain === 'finance'
    ? entry.data.details.map((item, key) => ({
      key, label: item.label, amount: item.amountMinor === null ? '' : moneyDecimal(item.amountMinor, entry.data.currency),
    })) : [])
  const nextKey = useRef(details.length)
  const [error, setError] = useState<ApiError>()
  const [busy, setBusy] = useState(false)
  const title = (entry ? 'Edit ' : 'Add ') + sections[domain].singular
  const set = (key: string, value: string | boolean) => setValues(current => ({ ...current, [key]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const data: Record<string, unknown> = Object.fromEntries(fields[domain].map(field => {
        const value = values[field.name]
        return [field.name, field.required ? value ?? '' : value === '' || value === undefined ? null : value]
      }))
      if (domain === 'diet' && data.calories !== null) {
        if (!/^\d+$/.test(String(data.calories).trim())) {
          throw new ApiError(400, 'Review the highlighted fields', [{ path: 'calories', message: 'Enter a whole number of calories' }])
        }
        data.calories = Number(data.calories)
      }
      if (domain === 'finance') {
        const validCurrency = currencySchema.safeParse(data.currency)
        if (!validCurrency.success) {
          throw new ApiError(400, 'Review the highlighted fields', [{ path: 'currency', message: 'Use a supported ISO currency code' }])
        }
        const currency = validCurrency.data
        const parse = (value: string, path: string) => {
          try { return parseMoney(value, currency) }
          catch (reason) {
            throw new ApiError(400, 'Review the highlighted fields', [{ path, message: reason instanceof Error ? reason.message : 'Invalid amount' }])
          }
        }
        data.amountMinor = parse(String(data.total), 'total')
        delete data.total
        data.details = details.map((item, index) => ({
          label: item.label, amountMinor: item.amount.trim() ? parse(item.amount, 'details.' + index + '.amountMinor') : null,
        }))
      }
      let validated: RecordData
      try { validated = parseRecord(domain, data) }
      catch (reason) {
        if (reason instanceof Error && 'issues' in reason && Array.isArray(reason.issues)) {
          throw new ApiError(400, 'Review the highlighted fields', reason.issues.map(issue => ({
            path: issue.path.join('.'), message: issue.message,
          })))
        }
        throw reason
      }
      const result = await request<AnyEntry>('records/' + domain + (entry ? '/' + entry.id : ''), {
        method: entry ? 'PUT' : 'POST', data: entry ? { data: validated, revision: entry.revision } : validated,
      })
      saved(result)
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError(0, 'The entry could not be saved.'))
    } finally { setBusy(false) }
  }

  async function reload() {
    setBusy(true)
    try { await refresh() }
    finally { setBusy(false) }
  }

  return <Modal title={title} close={() => { if (!busy) close() }}>
    <form onSubmit={submit} className="editor">
      {entry?.domain === 'profile' && !entry.data.archived && <p className="form-hint">Changing the current description keeps the previous value in field history.</p>}
      <div className="form-grid">
        {fields[domain].map(field => {
          const issue = error?.issues[field.name]
          const id = 'entry-' + field.name
          const input = {
            id, required: field.required, value: String(values[field.name] ?? ''),
            'aria-invalid': !!issue, 'aria-describedby': issue ? id + '-error' : undefined,
          }
          if (field.type === 'checkbox') return <label key={id} className="checkbox full">
            <input type="checkbox" checked={values[field.name] === true} onChange={event => set(field.name, event.target.checked)} />
            {field.label}
          </label>
          return <label className={field.type === 'textarea' ? 'full' : ''} key={id} htmlFor={id}>
            {field.label}{field.required && <span className="required" aria-hidden="true"> *</span>}
            {field.type === 'textarea' ? <textarea {...input} rows={4} onChange={event => set(field.name, event.target.value)} />
              : field.type === 'select' ? <select {...input} disabled={!!entry} onChange={event => set(field.name, event.target.value)}>
                <option value="income">Income</option><option value="expense">Expenses</option>
              </select> : <input {...input} type={field.type ?? 'text'}
                inputMode={field.name === 'total' ? 'decimal' : field.name === 'calories' ? 'numeric' : undefined}
                maxLength={field.name === 'currency' ? 3 : undefined} onChange={event => set(field.name, event.target.value)} />}
            {issue && <span className="field-error" id={id + '-error'}>{issue}</span>}
          </label>
        })}
      </div>
      {domain === 'finance' && <section className="breakdown-editor" aria-labelledby="breakdown-editor-title">
        <div className="section-bar">
          <h3 id="breakdown-editor-title">Breakdown</h3>
          <button type="button" className="button" disabled={details.length >= 50} onClick={() => {
            const key = nextKey.current++
            setDetails(items => [...items, { key, label: '', amount: '' }])
          }}><Plus size={16} /> Add row</button>
        </div>
        {details.length > 0 && <table>
          <thead><tr><th scope="col">Label</th><th scope="col">Amount</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{details.map((item, index) => <tr key={item.key}>
            {(['label', 'amount'] as const).map(key => {
              const issue = error?.issues['details.' + index + '.' + (key === 'amount' ? 'amountMinor' : key)]
              const errorId = 'detail-' + item.key + '-' + key
              return <td key={key}><input aria-label={key + ' for row ' + (index + 1)} value={item[key]} aria-invalid={!!issue}
                aria-describedby={issue ? errorId : undefined} required={key === 'label'} inputMode={key === 'amount' ? 'decimal' : undefined}
                onChange={event => setDetails(items => items.map(detail => detail.key === item.key ? { ...detail, [key]: event.target.value } : detail))} />
                {issue && <span className="field-error" id={errorId}>{issue}</span>}</td>
            })}
            <td><button type="button" className="icon-button" aria-label={'Remove breakdown row ' + (index + 1)} onClick={() => setDetails(items => items.filter(detail => detail.key !== item.key))}><X size={16} /></button></td>
          </tr>)}</tbody>
        </table>}
      </section>}
      {error && <p className="notice danger" role="alert">{error.message}</p>}
      <footer className="dialog-footer">
        {error && [404, 409].includes(error.status) && <button className="button" type="button" onClick={() => void reload()} disabled={busy}>Refresh records</button>}
        <button type="button" className="button" onClick={close} disabled={busy}>Cancel</button>
        <button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save entry'}</button>
      </footer>
    </form>
  </Modal>
}

export function DeleteDialog({ entry, close, deleted, refresh }: {
  entry: AnyEntry, close: () => void, deleted: () => void, refresh: () => Promise<void>,
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError>()
  async function remove() {
    setBusy(true)
    try {
      await request('records/' + entry.domain + '/' + entry.id, { method: 'DELETE', data: { revision: entry.revision } })
      deleted()
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError(0, 'The entry could not be deleted.'))
      setBusy(false)
    }
  }
  return <Modal title="Delete entry?" close={() => { if (!busy) close() }}>
    <div className="editor">
      <p>“{entryTitle(entry)}” will be permanently removed from your records.</p>
      {error && <p className="notice danger" role="alert">{error.message}</p>}
      <footer className="dialog-footer">
        {error && [404, 409].includes(error.status) && <button className="button" type="button" onClick={() => void refresh()}>Refresh records</button>}
        <button type="button" className="button" onClick={close} disabled={busy} autoFocus>Cancel</button>
        <button type="button" className="button destructive" disabled={busy} onClick={() => void remove()}>Delete entry</button>
      </footer>
    </div>
  </Modal>
}

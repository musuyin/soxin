import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { domains, fieldKey, parseRecord, querySchema } from '../shared/records.ts'
import type { AnyEntry, Domain, Entry, RecordData, RecordQuery } from '../shared/records.ts'
import { openDatabase, transaction } from './sqlite.ts'

const tables = {
  profile: ['profile'], diet: ['diet'], finance: ['income', 'expense'], workout: ['workout'], activity: ['activity'],
} as const

const eventDates = {
  profile: null, diet: 'mealDate', finance: 'month', workout: 'workoutDate', activity: 'eventDate',
} as const

function recordsMigration(domain: Domain) {
  const date = eventDates[domain]
  return tables[domain].map(table => `
    CREATE TABLE ${table} (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), data TEXT NOT NULL CHECK(json_valid(data))
      ${domain === 'profile' ? ", field_key TEXT NOT NULL, archived INTEGER GENERATED ALWAYS AS (json_extract(data, '$.archived')) STORED NOT NULL" : ''}
      ${domain === 'finance' ? ", month TEXT GENERATED ALWAYS AS (json_extract(data, '$.month')) STORED NOT NULL, currency TEXT GENERATED ALWAYS AS (json_extract(data, '$.currency')) STORED NOT NULL, UNIQUE(month, currency)" : ''}
    ) STRICT;
    CREATE INDEX ${table}_updated ON ${table}(updated_at DESC, id);
    ${date ? `CREATE INDEX ${table}_date ON ${table}(json_extract(data, '$.${date}'));` : ''}
    ${domain === 'profile' ? 'CREATE UNIQUE INDEX profile_current ON profile(field_key) WHERE archived = 0;' : ''}
  `).join('\n') + `
    CREATE TABLE applied (
      source_id TEXT NOT NULL, proposal_index INTEGER NOT NULL, outcome TEXT NOT NULL,
      PRIMARY KEY(source_id, proposal_index)
    ) STRICT;
  `
}

export class RecordConflict extends Error {}
export class RecordMissing extends Error {}

type Row = { id: string, created_at: string, updated_at: string, revision: number, data: string }
type Target = { id: string, revision: number }
export type Mutation = { domain: Domain, data: unknown, target?: Target }
export type Outcome = 'applied' | 'conflict'

function entry<D extends Domain>(domain: D, row: Row): Entry<D> {
  return {
    domain, id: row.id, createdAt: row.created_at, updatedAt: row.updated_at,
    revision: row.revision, data: JSON.parse(row.data),
  }
}

function clauses(domain: Domain, input: RecordQuery) {
  const query = querySchema.parse(input)
  const conditions: string[] = []
  const args: SQLInputValue[] = []
  const date = eventDates[domain]
  if (domain === 'profile') {
    if (query.history !== 'all') conditions.push(query.history === 'archived' ? 'archived = 1' : 'archived = 0')
    if (query.field) {
      conditions.push('field_key = ?')
      args.push(fieldKey(query.field))
    }
  }
  if (date && (query.from || query.to)) {
    const expression = `json_extract(data, '$.${date}')`
    if (query.from) {
      conditions.push(expression + ' >= ?')
      args.push(domain === 'finance' ? query.from.slice(0, 7) : query.from)
    }
    if (query.to) {
      conditions.push(expression + ' <= ?')
      args.push(domain === 'finance' ? query.to.slice(0, 7) : query.to)
    }
  }
  if (domain === 'finance') {
    for (const key of ['month', 'currency'] as const) {
      if (query[key]) {
        conditions.push(key + ' = ?')
        args.push(query[key])
      }
    }
  }
  if (query.text) {
    const searchable = {
      profile: ['field', 'tag', 'description'], diet: ['mealType', 'description'],
      finance: ['details'], workout: ['part', 'description'],
      activity: ['event', 'withWho', 'location', 'note', 'approximateTime'],
    }[domain]
    conditions.push('(' + searchable.map(key => `instr(lower(json_extract(data, '$.${key}')), lower(?)) > 0`).join(' OR ') + ')')
    args.push(...searchable.map(() => query.text!))
  }
  return { query, args, where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '' }
}

export class RecordStore {
  private readonly databases = new Map<Domain, DatabaseSync>()

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      for (const domain of domains) {
        this.databases.set(domain, openDatabase(join(directory, domain + '.sqlite'), [recordsMigration(domain)]))
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  close() {
    for (const db of this.databases.values()) db.close()
    this.databases.clear()
  }

  list<D extends Domain>(domain: D, input: RecordQuery = {}) {
    const { query, args, where } = clauses(domain, input)
    const selected = domain === 'finance' && query.kind ? [query.kind] : tables[domain]
    const union = selected.map(table => 'SELECT * FROM ' + table + where).join(' UNION ALL ')
    const db = this.databases.get(domain)!
    const rows = db.prepare(union + ' ORDER BY updated_at DESC, id LIMIT ? OFFSET ?')
      .all(...selected.flatMap(() => args), query.limit, query.offset) as Row[]
    return rows.map(row => entry(domain, row))
  }

  count(domain: Domain) {
    const db = this.databases.get(domain)!
    return tables[domain].reduce((total, table) => {
      const where = domain === 'profile' ? ' WHERE archived = 0' : ''
      return total + Number(db.prepare('SELECT count(*) AS total FROM ' + table + where).get()?.total)
    }, 0)
  }

  get<D extends Domain>(domain: D, id: string) {
    const db = this.databases.get(domain)!
    for (const table of tables[domain]) {
      const row = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id) as Row | undefined
      if (row) return entry(domain, row)
    }
  }

  overview() {
    const counts = Object.fromEntries(domains.map(domain => [domain, this.count(domain)]))
    const recent = domains.flatMap(domain => this.list(domain, { limit: 8 }) as AnyEntry[])
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)).slice(0, 8)
    return { counts, recent }
  }

  revisionSnapshot() {
    return Object.fromEntries(domains.map(domain => {
      const db = this.databases.get(domain)!
      const rows = tables[domain].flatMap(table => db.prepare('SELECT id, revision FROM ' + table).all())
      return [domain, new Map(rows.map(row => [String(row.id), Number(row.revision)]))]
    })) as Record<Domain, Map<string, number>>
  }

  create<D extends Domain>(domain: D, input: unknown) {
    const data = parseRecord(domain, input)
    return transaction(this.databases.get(domain)!, () => this.save(domain, data))
  }

  update<D extends Domain>(domain: D, id: string, revision: number, input: unknown) {
    const data = parseRecord(domain, input)
    return transaction(this.databases.get(domain)!, () => this.save(domain, data, { id, revision }))
  }

  delete(domain: Domain, id: string, revision: number) {
    const db = this.databases.get(domain)!
    transaction(db, () => {
      const existing = this.requireRevision(domain, { id, revision })
      const table = this.table(domain, existing.data)
      db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id)
    })
  }

  apply(domain: Domain, sourceId: string, changes: { index: number, mutation: Mutation }[]): Outcome[] {
    const db = this.databases.get(domain)!
    return transaction(db, () => changes.map(({ index, mutation }) => {
      const prior = db.prepare('SELECT outcome FROM applied WHERE source_id = ? AND proposal_index = ?').get(sourceId, index)
      if (prior) return prior.outcome as Outcome
      let outcome: Outcome = 'applied'
      try {
        this.save(domain, parseRecord(domain, mutation.data), mutation.target, true)
      } catch (error) {
        if (!(error instanceof RecordConflict || error instanceof RecordMissing)) throw error
        outcome = 'conflict'
      }
      db.prepare('INSERT INTO applied VALUES (?, ?, ?)').run(sourceId, index, outcome)
      return outcome
    }))
  }

  private requireRevision<D extends Domain>(domain: D, target: Target) {
    const previous = this.get(domain, target.id)
    if (!previous) throw new RecordMissing('This entry no longer exists')
    if (previous.revision !== target.revision) throw new RecordConflict('This entry changed. Refresh before editing again.')
    return previous
  }

  private table(domain: Domain, data: RecordData) {
    return domain === 'finance' ? (data as RecordData<'finance'>).kind : domain
  }

  private archive(db: DatabaseSync, id: string, time: string) {
    db.prepare(`UPDATE profile SET data = json_set(data, '$.archived', json('true')),
      revision = revision + 1, updated_at = ? WHERE id = ?`).run(time, id)
  }

  private save<D extends Domain>(domain: D, data: RecordData<D>, target?: Target, extracted = false): Entry<D> {
    const db = this.databases.get(domain)!
    const previous = target ? this.requireRevision(domain, target) : undefined
    const time = new Date().toISOString()
    const table = this.table(domain, data)
    let update = previous
    let profileKey: string | undefined

    if (domain === 'finance') {
      const finance = data as RecordData<'finance'>
      if (previous && this.table(domain, previous.data) !== table) throw new RecordConflict('Income and expense entries have a fixed type')
      const duplicate = db.prepare('SELECT id FROM ' + table + ' WHERE month = ? AND currency = ?').get(finance.month, finance.currency)
      if (duplicate && duplicate.id !== previous?.id) throw new RecordConflict('An entry already exists for this month and currency')
    }

    if (domain === 'profile') {
      const fact = data as RecordData<'profile'>
      profileKey = fieldKey(fact.field)
      const oldFact = previous?.data as RecordData<'profile'> | undefined
      const current = db.prepare('SELECT id FROM profile WHERE field_key = ? AND archived = 0').get(profileKey)
      if (!fact.archived && current && current.id !== previous?.id) {
        if (previous || extracted) throw new RecordConflict('Another current value exists for this field. Edit that value to replace it.')
        this.archive(db, String(current.id), time)
      }
      if (previous && oldFact && !oldFact.archived && !fact.archived &&
          (oldFact.description !== fact.description || fieldKey(oldFact.field) !== profileKey)) {
        this.archive(db, previous.id, time)
        update = undefined
      }
    }

    const payload = JSON.stringify(data)
    const profileArgs = profileKey === undefined ? [] : [profileKey]
    if (update) {
      const field = profileKey === undefined ? '' : ', field_key = ?'
      db.prepare('UPDATE ' + table + ' SET updated_at = ?, revision = revision + 1, data = ?' + field + ' WHERE id = ?')
        .run(time, payload, ...profileArgs, update.id)
      return this.get(domain, update.id)!
    }

    const id = randomUUID()
    const extraColumn = profileKey === undefined ? '' : ', field_key'
    const extraValue = profileKey === undefined ? '' : ', ?'
    db.prepare('INSERT INTO ' + table + ' (id, created_at, updated_at, revision, data' + extraColumn + ') VALUES (?, ?, ?, 1, ?' + extraValue + ')')
      .run(id, time, time, payload, ...profileArgs)
    return this.get(domain, id)!
  }
}

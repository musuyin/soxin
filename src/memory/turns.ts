import { domains, fieldKey, localDay, parseMoney, parseRecord } from '../shared/records.ts'
import type { AnyEntry, Domain, Entry, RecordData } from '../shared/records.ts'
import type { Mutation, RecordStore } from '../storage/records.ts'
import type { Batch, ServiceState, TurnReply, WriteReport } from '../storage/service-state.ts'
import { extractionSchema, retrievalSchema, RunnerFailure } from './protocol.ts'
import type { Calendar, ChatRunner, MemoryRunner, Proposal, TurnInput } from './protocol.ts'

function date(value: string | null, calendar: Calendar) {
  if (!value) return undefined
  if (value === 'today' || value === 'yesterday' || value === 'tomorrow') return calendar[value]
  return value
}

function snapshotContext(input: TurnInput, timezone: string): Calendar {
  return {
    today: localDay(input.timestamp, timezone), yesterday: localDay(input.timestamp, timezone, -1),
    tomorrow: localDay(input.timestamp, timezone, 1), timezone,
  }
}

function retrieve(store: RecordStore, raw: unknown, calendar: Calendar) {
  const records: AnyEntry[] = []
  const seen = new Set<string>()
  let size = 0
  for (const query of retrievalSchema.parse(raw).queries) {
    const hits = store.list(query.domain, {
      text: query.text ?? undefined, field: query.field ?? undefined,
      from: date(query.from, calendar), to: date(query.to, calendar),
      month: query.month ?? undefined, currency: query.currency ?? undefined, kind: query.kind ?? undefined,
      history: query.historical ? 'archived' : 'current', limit: query.limit,
    }) as AnyEntry[]
    for (const hit of hits) {
      const length = JSON.stringify(hit).length
      if (seen.has(hit.id) || size + length > 18_000) continue
      records.push(hit)
      seen.add(hit.id)
      size += length
      if (records.length >= 16) return records
    }
  }
  return records
}

function revisionOf(entry: Entry | undefined) {
  return entry && { id: entry.id, revision: entry.revision }
}

function proposalValue(store: RecordStore, proposal: Proposal, calendar: Calendar): Mutation | 'conflict' | undefined {
  const { domain } = proposal
  if (domain === 'profile') {
    const { field, tag, description } = proposal
    const [prior] = store.list(domain, { field, limit: 1 })
    if (prior && prior.data.description === description && prior.data.tag === tag) return
    return { domain, target: revisionOf(prior), data: { field, tag, description, archived: false } }
  }
  if (domain === 'finance') {
    const { kind, month, basis } = proposal
    if (basis === 'individual-payment') return
    const currency = proposal.currency ?? 'CNY'
    const [prior] = store.list(domain, { kind, month, currency, limit: 1 })
    if (basis === 'monthly-breakdown' && !prior) return 'conflict'
    if (basis === 'monthly-total' && proposal.total === null) throw new Error('Missing monthly total')
    const amountMinor = basis === 'monthly-total' ? parseMoney(proposal.total!, currency) : prior!.data.amountMinor
    const details = proposal.details.map(item => ({
      label: item.label, amountMinor: item.amount === null ? null : parseMoney(item.amount, currency),
    }))
    const merged = new Map((prior?.data.details ?? []).map(item => [fieldKey(item.label), item]))
    for (const item of details) {
      const key = fieldKey(item.label)
      merged.set(key, { ...item, amountMinor: item.amountMinor ?? merged.get(key)?.amountMinor ?? null })
    }
    return { domain, target: revisionOf(prior), data: { kind, month, currency, amountMinor, details: [...merged.values()] } }
  }

  const { target } = proposal
  const targetDate = date(target?.date ?? null, calendar)
  const targetText = target?.text ?? undefined
  if (target && !targetDate && !targetText) throw new Error('A correction needs a selector')
  const matches = target ? store.list(domain, { from: targetDate, to: targetDate, text: targetText, limit: 2 }) : []
  if (target && matches.length !== 1) return 'conflict'
  const prior = matches[0]
  let data: RecordData
  switch (domain) {
    case 'diet': {
      const previous = prior?.data as RecordData<'diet'> | undefined
      data = parseRecord(domain, {
        mealDate: date(proposal.mealDate, calendar) ?? previous?.mealDate,
        mealType: proposal.mealType ?? previous?.mealType,
        description: proposal.description ?? previous?.description,
        calories: proposal.calories ?? previous?.calories ?? null,
      })
      break
    }
    case 'workout': {
      const previous = prior?.data as RecordData<'workout'> | undefined
      data = parseRecord(domain, {
        workoutDate: date(proposal.workoutDate, calendar) ?? previous?.workoutDate,
        part: proposal.part ?? previous?.part, description: proposal.description ?? previous?.description,
      })
      break
    }
    case 'activity': {
      const previous = prior?.data as RecordData<'activity'> | undefined
      data = parseRecord(domain, {
        eventDate: date(proposal.eventDate, calendar) ?? previous?.eventDate ?? null,
        approximateTime: proposal.approximateTime ?? previous?.approximateTime ?? null,
        event: proposal.event ?? previous?.event, withWho: proposal.withWho ?? previous?.withWho ?? null,
        location: proposal.location ?? previous?.location ?? null, note: proposal.note ?? previous?.note ?? null,
      })
    }
  }
  return { domain, target: revisionOf(prior), data }
}

export type Log = (event: string) => void

export class TurnHandler {
  private readonly store: RecordStore
  private readonly state: ServiceState
  private readonly memory: MemoryRunner
  private readonly chat: ChatRunner
  private readonly timezone: string
  private readonly log: Log

  constructor(
    store: RecordStore, state: ServiceState, memory: MemoryRunner, chat: ChatRunner, timezone: string, log: Log,
  ) {
    this.store = store
    this.state = state
    this.memory = memory
    this.chat = chat
    this.timezone = timezone
    this.log = log
  }

  recoverPending() {
    for (const { sourceId, batch, conflicts } of this.state.pending()) this.commit(sourceId, batch, conflicts)
  }

  private commit(sourceId: string, batch: Batch, conflicts: number): WriteReport {
    for (const domain of domains) {
      const changes = batch.filter(change => change.mutation.domain === domain)
      if (changes.length) {
        conflicts += this.store.apply(domain, sourceId, changes).filter(outcome => outcome === 'conflict').length
      }
    }
    const report = { conflicts, extractionFailed: false }
    this.state.finishBatch(sourceId, report)
    return report
  }

  async handle(input: TurnInput): Promise<TurnReply> {
    const known = this.state.turn(input.sourceId)
    if (known.reply) return known.reply

    const calendar = snapshotContext(input, this.timezone)
    const revisions = known.report || known.batch ? undefined : this.store.revisionSnapshot()
    const extraction = revisions ? Promise.resolve()
      .then(() => this.memory.extract(input, calendar))
      .catch(error => {
        if (error instanceof RunnerFailure) this.log(error.message)
        return undefined
      }) : undefined
    const read = known.read ?? await Promise.resolve().then(() => this.memory.retrieve(input, calendar))
      .then(raw => retrieve(this.store, raw, calendar))
      .then(records => ({ records, failed: false }), error => {
        this.log(error instanceof RunnerFailure ? error.message : 'Memory retrieval failed')
        return { records: [], failed: true }
      })
    if (!known.read) {
      try { this.state.saveRead(input.sourceId, read) }
      catch (error) {
        await extraction
        throw error
      }
    }

    const chat = Promise.resolve().then(() => this.chat.reply(input, read.records, this.state.active(input.channelId)))
    const writes = async () => {
      if (known.report) return known.report
      if (known.batch) return this.commit(input.sourceId, known.batch.batch, known.batch.conflicts)
      const result = await extraction
      if (read.failed) {
        const report = { conflicts: 0, extractionFailed: false }
        this.state.finishBatch(input.sourceId, report)
        return report
      }
      let conflicts = 0
      let batch: Batch
      try {
        batch = extractionSchema.parse(result).proposals.flatMap((proposal, index) => {
          const mutation = proposalValue(this.store, proposal, calendar)
          if (!mutation) return []
          if (mutation === 'conflict' || (mutation.target && revisions?.[mutation.domain].get(mutation.target.id) !== mutation.target.revision)) {
            conflicts++
            return []
          }
          return [{ index, mutation: { ...mutation, data: parseRecord(mutation.domain, mutation.data) } }]
        })
      } catch {
        this.log('Memory extraction failed or returned invalid proposals')
        const report = { conflicts: 0, extractionFailed: true }
        this.state.finishBatch(input.sourceId, report)
        return report
      }
      this.state.saveBatch(input.sourceId, batch, conflicts)
      return this.commit(input.sourceId, batch, conflicts)
    }

    const [answer, report] = await Promise.allSettled([chat, writes()])
    if (report.status === 'rejected') throw report.reason
    if (answer.status === 'rejected') throw answer.reason

    const warning = [
      read.failed && 'Memory lookup failed. This reply uses the conversation and message only. This message made no new memory changes.',
      report.value.extractionFailed && 'Memory extraction failed. This message made no new memory changes.',
      report.value.conflicts > 0 && (report.value.conflicts + ' memory change(s) skipped because the target was missing, ambiguous, or changed. Check the dashboard.'),
    ].filter(Boolean).join('\n')
    const reply = warning ? { text: answer.value.text, warning } : { text: answer.value.text }
    this.state.saveReply(input.sourceId, reply, input.channelId, answer.value.sessionId)
    return reply
  }
}

export class ChannelQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(channel: string, work: () => Promise<T>) {
    const result = (this.tails.get(channel) ?? Promise.resolve()).then(work)
    const tail = result.catch(() => {})
    this.tails.set(channel, tail)
    void tail.then(() => {
      if (this.tails.get(channel) === tail) this.tails.delete(channel)
    })
    return result
  }

  async drain() { await Promise.all(this.tails.values()) }
}

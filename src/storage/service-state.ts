import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AnyEntry } from '../shared/records.ts'
import type { Mutation } from './records.ts'
import { openDatabase, transaction } from './sqlite.ts'

export type Batch = { index: number, mutation: Mutation }[]
type PendingBatch = { batch: Batch, conflicts: number }
export type WriteReport = { conflicts: number, extractionFailed: boolean }
export type TurnReply = { text: string, warning?: string }
export type TurnRead = { records: AnyEntry[], failed: boolean }

export class ServiceState {
  private readonly db: DatabaseSync

  constructor(directory: string) {
    this.db = openDatabase(join(directory, 'service.sqlite'), [`
      CREATE TABLE turns (
        source_id TEXT PRIMARY KEY, retrieval TEXT, batch TEXT, report TEXT, reply TEXT
      ) STRICT;
      CREATE TABLE sessions (
        channel TEXT NOT NULL, id TEXT NOT NULL, last_used TEXT NOT NULL, PRIMARY KEY(channel, id)
      ) STRICT;
      CREATE TABLE active_sessions (channel TEXT PRIMARY KEY, id TEXT NOT NULL) STRICT;
    `])
  }

  close() { this.db.close() }

  turn(sourceId: string) {
    const row = this.db.prepare('SELECT retrieval, batch, report, reply FROM turns WHERE source_id = ?').get(sourceId)
    return {
      read: row?.retrieval ? JSON.parse(String(row.retrieval)) as TurnRead : undefined,
      batch: row?.batch ? JSON.parse(String(row.batch)) as PendingBatch : undefined,
      report: row?.report ? JSON.parse(String(row.report)) as WriteReport : undefined,
      reply: row?.reply ? JSON.parse(String(row.reply)) as TurnReply : undefined,
    }
  }

  saveRead(sourceId: string, read: TurnRead) {
    this.db.prepare('INSERT INTO turns (source_id, retrieval) VALUES (?, ?)').run(sourceId, JSON.stringify(read))
  }

  saveBatch(sourceId: string, batch: Batch, conflicts: number) {
    this.db.prepare(`INSERT INTO turns (source_id, batch) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET batch = excluded.batch`).run(sourceId, JSON.stringify({ batch, conflicts }))
  }

  pending() {
    return this.db.prepare('SELECT source_id, batch FROM turns WHERE batch IS NOT NULL ORDER BY rowid').all()
      .map(row => ({ sourceId: String(row.source_id), ...JSON.parse(String(row.batch)) as PendingBatch }))
  }

  finishBatch(sourceId: string, report: WriteReport) {
    this.db.prepare(`INSERT INTO turns (source_id, report) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET report = excluded.report, batch = NULL`).run(sourceId, JSON.stringify(report))
  }

  saveReply(sourceId: string, reply: TurnReply, channel: string, session: string) {
    transaction(this.db, () => {
      this.db.prepare('UPDATE turns SET reply = ?, retrieval = NULL WHERE source_id = ?').run(JSON.stringify(reply), sourceId)
      this.rememberSession(channel, session)
    })
  }

  active(channel: string) {
    return this.db.prepare('SELECT id FROM active_sessions WHERE channel = ?').get(channel)?.id as string | undefined
  }

  sessions(channel: string) {
    return this.db.prepare('SELECT id, last_used FROM sessions WHERE channel = ? ORDER BY last_used DESC, id LIMIT 20')
      .all(channel).map(row => ({ id: String(row.id), lastUsed: String(row.last_used) }))
  }

  newSession(channel: string) {
    this.db.prepare('DELETE FROM active_sessions WHERE channel = ?').run(channel)
  }

  resume(channel: string, id: string) {
    if (!this.db.prepare('SELECT id FROM sessions WHERE channel = ? AND id = ?').get(channel, id)) return false
    transaction(this.db, () => this.rememberSession(channel, id))
    return true
  }

  private rememberSession(channel: string, id: string) {
    this.db.prepare(`INSERT INTO sessions VALUES (?, ?, ?)
      ON CONFLICT(channel, id) DO UPDATE SET last_used = excluded.last_used`).run(channel, id, new Date().toISOString())
    this.db.prepare(`INSERT INTO active_sessions VALUES (?, ?)
      ON CONFLICT(channel) DO UPDATE SET id = excluded.id`).run(channel, id)
  }
}

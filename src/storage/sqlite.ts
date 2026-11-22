import { DatabaseSync } from 'node:sqlite'

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openDatabase(path: string, migrations: string[]) {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
    transaction(db, () => {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      if (version > migrations.length) throw new Error('Database uses a newer schema')
      for (let index = version; index < migrations.length; index++) {
        db.exec(migrations[index])
        db.exec('PRAGMA user_version = ' + (index + 1))
      }
    })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

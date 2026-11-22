import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { domains, localDay, moneyDecimal, parseMoney } from '../src/shared/records.ts'
import { RecordConflict, RecordStore } from '../src/storage/records.ts'

test('all five domains persist, with profile history and separate finance totals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'soxin-records-'))
  let store = new RecordStore(directory)
  try {
    const current = store.create('profile', { field: 'Tea', tag: 'drinks', description: 'Jasmine', archived: false })
    const newer = store.update('profile', current.id, 1, { ...current.data, description: 'Oolong' })
    assert.notEqual(newer.id, current.id)
    assert.equal(store.get('profile', current.id)?.revision, 2)
    assert.equal(store.get('profile', current.id)?.data.description, 'Jasmine')
    assert.equal(store.get('profile', current.id)?.data.archived, true)
    assert.deepEqual(store.list('profile', { field: ' TEA ' }).map(row => row.id), [newer.id])
    assert.equal(store.list('profile', { history: 'archived', field: 'tea' }).length, 1)

    const date = localDay('2026-01-01T17:00:00Z', 'Asia/Shanghai', -1)
    const dinner = store.create('diet', { mealDate: date, mealType: 'Dinner', description: 'Rice', calories: null })
    assert.equal(dinner.data.mealDate, '2026-01-01')
    assert.equal(store.update('diet', dinner.id, 1, { ...dinner.data, calories: 340 }).revision, 2)
    assert.throws(() => store.update('diet', dinner.id, 1, { ...dinner.data, calories: 930 }), RecordConflict)
    assert.throws(() => store.delete('diet', dinner.id, 1), RecordConflict)

    const income = store.create('finance', {
      kind: 'income', month: '2026-01', amountMinor: parseMoney('12.50', 'CNY'), details: [{ label: 'Gift', amountMinor: 1000 }],
    })
    assert.equal(income.data.currency, 'CNY')
    assert.equal(income.data.amountMinor, 1250)
    assert.equal(moneyDecimal(income.data.amountMinor, income.data.currency), '12.50')
    assert.throws(() => store.create('finance', income.data), RecordConflict)
    const expense = store.create('finance', { ...income.data, kind: 'expense' })
    const yen = store.create('finance', { ...income.data, currency: 'JPY', amountMinor: 1000, details: [] })
    assert.equal(store.list('finance', { month: '2026-01', currency: 'JPY' })[0].id, yen.id)
    assert.equal(store.list('finance', { kind: 'expense' })[0].id, expense.id)
    assert.equal(store.list('finance').length, 3)

    const workout = store.create('workout', { workoutDate: date, part: 'Legs', description: 'Squats, 3 sets' })
    const activity = store.create('activity', { event: 'Walk', eventDate: null, approximateTime: 'at dusk', withWho: null, location: 'Park', note: null })
    store.close()
    assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.sqlite')).sort(), domains.map(domain => domain + '.sqlite').sort())
    store = new RecordStore(directory)
    assert.equal(store.get('profile', newer.id)?.data.description, 'Oolong')
    assert.equal(store.get('diet', dinner.id)?.data.calories, 340)
    assert.equal(store.get('finance', income.id)?.data.details[0].amountMinor, 1000)
    assert.equal(store.get('workout', workout.id)?.data.description, 'Squats, 3 sets')
    assert.equal(store.get('activity', activity.id)?.data.approximateTime, 'at dusk')
    store.delete('activity', activity.id, activity.revision)
    assert.equal(store.get('activity', activity.id), undefined)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('decimal currency conversion handles zero and three decimal places exactly', () => {
  assert.equal(parseMoney('27', 'JPY'), 27)
  assert.throws(() => parseMoney('27.01', 'JPY'))
  assert.equal(parseMoney('12.005', 'KWD'), 12005)
  assert.equal(moneyDecimal(12005, 'KWD'), '12.005')
  assert.equal(moneyDecimal(Number.MAX_SAFE_INTEGER, 'CNY'), '90071992547409.91')
})

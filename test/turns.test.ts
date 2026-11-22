import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ChannelQueue, TurnHandler } from '../src/memory/turns.ts'
import type { ChatRunner, MemoryRunner, TurnInput } from '../src/memory/protocol.ts'
import { RecordStore } from '../src/storage/records.ts'
import { ServiceState } from '../src/storage/service-state.ts'

const input: TurnInput = {
  sourceId: 'test-1', channelId: 'test-channel', userId: 'test-owner', timestamp: '2026-01-02T17:00:00Z',
  text: 'How does this compare with yesterday?', images: ['/synthetic/meal.jpg'],
}
const mealQuery = {
  domain: 'diet', from: 'yesterday', to: 'yesterday', text: null,
  field: null, month: null, currency: null, kind: null, historical: false, limit: 3,
}
const dietProposal = {
  domain: 'diet', target: null, mealDate: 'today', mealType: 'Lunch', description: 'Rice and tofu (visual estimate)', calories: 430,
}
const activityProposal = {
  domain: 'activity', target: null, eventDate: 'today', approximateTime: 'at dusk', event: 'Walk',
  withWho: null, location: null, note: null,
}
const empty = { queries: [] }
const noChanges = { proposals: [] }

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'soxin-turn-'))
  let store = new RecordStore(directory)
  let state = new ServiceState(directory)
  function close() { state.close(); store.close() }
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    restart() { close(); store = new RecordStore(directory); state = new ServiceState(directory) },
    get store() { return store },
    get state() { return state },
    handler(memory: MemoryRunner, chat: ChatRunner) {
      return new TurnHandler(store, state, memory, chat, 'Asia/Shanghai', () => {})
    },
  }
}

test('photo extraction finishes before retrieval, and a fresh session after restart recalls the dashboard correction', async t => {
  const env = fixture(t)
  const earlier = env.store.create('diet', { mealDate: '2026-01-02', mealType: 'Lunch', description: 'Noodles', calories: 390 })
  const extracted = Promise.withResolvers<void>()
  let extractions = 0
  let replies = 0
  const chat: ChatRunner = {
    async reply(original, memory, sessionId) {
      replies++
      if (replies === 1) {
        assert.equal(original, input)
        assert.deepEqual(memory, [earlier])
        assert.equal(sessionId, undefined)
      } else {
        assert.equal(sessionId, undefined)
        assert.equal(memory.length, 1)
        assert.equal(memory[0].domain === 'diet' && memory[0].data.calories, 415)
      }
      return { text: 'A synthetic reply.', sessionId: 'session-' + replies }
    },
  }
  const turn = env.handler({
    async retrieve() {
      await extracted.promise
      assert.equal(env.store.count('diet'), 1)
      return { queries: [mealQuery] }
    },
    async extract() {
      extractions++
      extracted.resolve()
      return { proposals: [dietProposal] }
    },
  }, chat)
  const result = await turn.handle(input)
  assert.equal(result.warning, undefined)
  const [newMeal] = env.store.list('diet', { from: '2026-01-03', to: '2026-01-03' })
  assert.equal(newMeal.data.calories, 430)
  assert.deepEqual(await turn.handle(input), result)
  assert.equal(extractions, 1)
  assert.equal(env.store.count('diet'), 2)
  assert.equal(env.state.active(input.channelId), 'session-1')

  env.store.update('diet', newMeal.id, newMeal.revision, { ...newMeal.data, calories: 415 })
  env.state.newSession(input.channelId)
  env.restart()
  await env.handler({
    async retrieve() { return { queries: [mealQuery] } },
    async extract() { return noChanges },
  }, chat).handle({ ...input, timestamp: '2026-01-03T17:00:00Z', sourceId: 'test-2', images: [] })
  assert.equal(env.state.active(input.channelId), 'session-2')
  assert.equal(env.state.resume('other-channel', 'session-1'), false)
  assert.equal(env.state.resume(input.channelId, 'session-1'), true)
  env.restart()
  assert.equal(env.state.active(input.channelId), 'session-1')
})

test('malformed proposals and lookup errors leave memory unchanged while chat receives an empty context', async t => {
  const env = fixture(t)
  const chat: ChatRunner = {
    async reply(_input, memory) {
      assert.deepEqual(memory, [])
      return { text: 'ok', sessionId: 's' }
    },
  }
  const bad = await env.handler({
    async retrieve() { return empty },
    async extract() { return { proposals: [dietProposal, { ...activityProposal, event: null }] } },
  }, chat).handle(input)
  assert.match(bad.warning ?? '', /extraction failed/)
  assert.equal(env.store.count('diet'), 0)
  const lookup = await env.handler({
    async retrieve() { throw new Error('synthetic failure') },
    async extract() { return { proposals: [dietProposal] } },
  }, chat).handle({ ...input, sourceId: 'test-2' })
  assert.match(lookup.warning ?? '', /lookup failed/)
  assert.equal(env.store.count('diet'), 0)
})

test('an interrupted multi-domain write resumes the stored batch through restart', async t => {
  const env = fixture(t)
  const memory: MemoryRunner = {
    async retrieve() { return empty },
    async extract() { return { proposals: [dietProposal, activityProposal] } },
  }
  const chat: ChatRunner = { async reply() { return { text: 'ok', sessionId: 's' } } }
  const apply = env.store.apply.bind(env.store)
  env.store.apply = (domain, ...args) => {
    if (domain === 'activity') throw new Error('simulated interrupted commit')
    return apply(domain, ...args)
  }

  await assert.rejects(env.handler(memory, chat).handle(input), /interrupted/)
  assert.equal(env.store.count('diet'), 1)
  assert.equal(env.store.count('activity'), 0)
  assert.equal(env.state.pending().length, 1)

  env.restart()
  const recovered = env.handler({
    async retrieve() { assert.fail('should reuse the original retrieval') },
    async extract() { assert.fail('should reuse the stored batch') },
  }, chat)
  recovered.recoverPending()
  await recovered.handle(input)
  assert.equal(env.store.count('diet'), 1)
  assert.equal(env.store.count('activity'), 1)
  assert.equal(env.state.pending().length, 0)
})

test('quarantines a stale correction and preserves explicitly reported finance totals', async t => {
  const env = fixture(t)
  const prior = env.store.create('diet', { mealDate: '2026-01-02', mealType: 'Lunch', description: 'Salad', calories: 350 })
  env.store.create('finance', { kind: 'expense', month: '2026-01', amountMinor: 1250, details: [] })
  const turn = env.handler({
    async retrieve() { return empty },
    async extract() {
      env.store.update('diet', prior.id, prior.revision, { ...prior.data, calories: 370 })
      const finance = { domain: 'finance', kind: 'expense', month: '2026-01', currency: 'CNY', details: [{ label: 'Bus fare', amount: '3' }] }
      return { proposals: [
        { ...dietProposal, target: { date: 'yesterday', text: 'Salad' }, mealDate: null, description: null },
        { ...finance, basis: 'individual-payment', total: '3.00' },
        { ...finance, basis: 'monthly-breakdown', total: null },
      ] }
    },
  }, { async reply() { return { text: 'ok', sessionId: 's' } } })
  const result = await turn.handle(input)
  assert.match(result.warning ?? '', /1 memory change/)
  assert.equal(env.store.get('diet', prior.id)?.data.calories, 370)
  const [expense] = env.store.list('finance')
  assert.equal(expense.data.amountMinor, 1250)
  assert.deepEqual(expense.data.details, [{ label: 'Bus fare', amountMinor: 300 }])
})

test('channel queue holds the next turn and allows independent channels through', async () => {
  const queue = new ChannelQueue()
  const wait = Promise.withResolvers<void>()
  const first = queue.run('one', () => wait.promise)
  let secondRan = false
  const second = queue.run('one', async () => { secondRan = true })
  await queue.run('two', async () => assert.equal(secondRan, false))
  wait.resolve()
  await Promise.all([first, second, queue.drain()])
  assert.equal(secondRan, true)
})

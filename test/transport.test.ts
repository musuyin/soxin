import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { admitted, splitReply } from '../src/adapters/discord.ts'
import { dashboardServer } from '../src/service/dashboard.ts'
import { RecordStore } from '../src/storage/records.ts'

test('Discord admission requires both owner and channel, and reply splitting keeps Unicode intact', () => {
  const config = { allowedUser: 'owner', allowedChannels: ['soxin'] }
  assert.ok(admitted(config, 'owner', 'soxin'))
  assert.ok(!admitted(config, 'other', 'soxin'))
  assert.ok(!admitted(config, 'owner', 'other'))
  const text = 'x'.repeat(1999) + '🍚' + 'y'.repeat(2010)
  const parts = splitReply(text)
  assert.ok(parts.every(part => part.length <= 2000))
  assert.equal(parts.join(''), text)
})

test('Dashboard HTTP and stdio MCP share data and revision checks without model runners', { timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'soxin-transports-'))
  const config = JSON.parse(readFileSync('soxin.example.json', 'utf8'))
  config.dataDirectory = directory
  const configPath = join(directory, 'test-config.json')
  writeFileSync(configPath, JSON.stringify(config))
  const store = new RecordStore(directory)
  const server = dashboardServer({
    store, directory, timezone: config.timezone, discordStatus: () => 'disabled',
    log: () => {},
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = 'http://127.0.0.1:' + address.port
  const child = spawn(process.execPath, ['src/adapters/mcp.ts'], { env: { ...process.env, SOXIN_CONFIG: configPath } })
  const closed = once(child, 'close')
  const lines = createInterface({ input: child.stdout })
  const responses = new Map<number, (reply: any) => void>()
  lines.on('line', line => {
    const response = JSON.parse(line)
    responses.get(response.id)?.(response)
    responses.delete(response.id)
  })
  t.after(async () => {
    lines.close()
    child.stdin.end()
    await closed
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  let id = 0
  function rpc(method: string, params: unknown = {}) {
    const request = ++id
    return new Promise<any>(resolve => {
      responses.set(request, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) + '\n')
    })
  }
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'soxin-test', version: '1' } })
  assert.equal(init.result.serverInfo.name, 'soxin-records')
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  const listed = await rpc('tools/list')
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ['create_record', 'delete_record', 'get_record', 'list_records', 'update_record'])
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result

  const raw = await fetch(base + '/api/overview')
  assert.equal((await raw.json()).discord, 'disabled')
  const meal = { mealDate: '2026-01-01', mealType: 'Dinner', description: 'Noodles', calories: null }
  const { structuredContent } = await call('create_record', { domain: 'diet', data: meal })
  const { id: entryId, revision } = structuredContent.result
  const url = base + '/api/records/diet/' + entryId
  const read = await fetch(url)
  assert.deepEqual((await read.json()).data, meal)
  const write = await fetch(url, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, data: { ...meal, calories: 310 } }),
  })
  assert.equal(write.status, 200)
  const stale = await call('update_record', { domain: 'diet', id: entryId, revision, data: { ...meal, calories: 900 } })
  assert.equal(stale.isError, true)
  const fresh = await call('get_record', { domain: 'diet', id: entryId })
  assert.equal(fresh.structuredContent.result.data.calories, 310)
  const found = await call('list_records', { domain: 'diet', filters: { from: '2026-01-01', to: '2026-01-01' } })
  assert.equal(found.structuredContent.result.length, 1)
  const removed = await call('delete_record', { domain: 'diet', id: entryId, revision: fresh.structuredContent.result.revision })
  assert.equal(removed.structuredContent.result.deleted, true)
  assert.equal((await fetch(url)).status, 404)
  assert.equal((await fetch(base + '/api/overview', { headers: { origin: 'http://example.invalid' } })).status, 403)
})

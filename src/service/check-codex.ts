import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter, CodexFailure } from '../adapters/codex.ts'
import { extractionSchema, retrievalSchema } from '../memory/protocol.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()
const directory = await mkdtemp(join(tmpdir(), 'soxin-check-'))
const input = {
  sourceId: 'synthetic', userId: 'synthetic', channelId: 'synthetic',
  timestamp: '2026-01-02T04:00:00.000Z', text: 'Yesterday I had rice and greens for dinner.', images: [],
}
const calendar = { today: '2026-01-02', yesterday: '2026-01-01', tomorrow: '2026-01-03', timezone: 'Asia/Shanghai' }
const runner = new CodexAdapter(config.codex, directory)
try {
  const checks = await Promise.allSettled([
    (async () => {
      const first = await runner.reply({ ...input, text: 'Reply with the word ready.' }, [])
      const resumed = await runner.reply({ ...input, text: 'Reply with the word resumed.' }, [], first.sessionId)
      if (resumed.sessionId !== first.sessionId) throw new Error('Chat session ID changed on resume.')
    })(),
    (async () => {
      const results = await Promise.allSettled([
        runner.extract(input, calendar).then(value => extractionSchema.parse(value)),
        runner.retrieve({ ...input, text: 'What did I eat yesterday?' }, calendar).then(value => retrievalSchema.parse(value)),
      ])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    })(),
  ])
  for (const [index, result] of checks.entries()) {
    const role = index === 0 ? 'chat' : 'memory'
    if (result.status === 'fulfilled') console.log(role + ' round trip passed')
    else {
      process.exitCode = 1
      console.error(result.reason instanceof CodexFailure ? result.reason.message : role + ' round trip failed validation')
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

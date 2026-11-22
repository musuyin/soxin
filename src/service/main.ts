import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAdapter } from '../adapters/codex.ts'
import { connectDiscord } from '../adapters/discord.ts'
import { ChannelQueue, TurnHandler } from '../memory/turns.ts'
import { RecordStore } from '../storage/records.ts'
import { ServiceState } from '../storage/service-state.ts'
import { loadConfig } from './config.ts'
import { dashboardServer } from './dashboard.ts'

async function start() {
  const config = loadConfig()
  const log = (message: string) => console.error('[SoXin] ' + message)
  const store = new RecordStore(config.dataDirectory)
  const state = new ServiceState(config.dataDirectory)
  const runtimeKey = createHash('sha256').update(realpathSync(config.dataDirectory)).digest('hex').slice(0, 20)
  const adapter = new CodexAdapter(config.codex, join(tmpdir(), 'soxin-codex-' + runtimeKey))
  const handler = new TurnHandler(store, state, adapter, adapter, config.timezone, log)
  const queue = new ChannelQueue()
  handler.recoverPending()

  let discord: ReturnType<typeof connectDiscord> | undefined
  const server = dashboardServer({
    store, timezone: config.timezone, log,
    discordStatus: () => discord?.status() ?? 'disabled',
    directory: fileURLToPath(new URL('../../dist/dashboard', import.meta.url)),
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.dashboardPort, '127.0.0.1', resolve)
  })
  console.log('SoXin dashboard: http://127.0.0.1:' + config.dashboardPort)
  discord = connectDiscord(config.discord, process.env.DISCORD_BOT_TOKEN, queue, handler, state, log)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    const httpClosed = new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all([httpClosed, discord?.close()])
    state.close()
    store.close()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void stop().catch(() => {
      log('Service shutdown failed')
      process.exit(1)
    }))
  }
}

await start().catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error('SoXin dashboard port is already in use. Check dashboardPort.')
  else console.error('SoXin could not start. Check the configuration file, selected data directory, and SQLite files.')
  process.exitCode = 1
})

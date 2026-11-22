import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const discordId = z.string().regex(/^\d{17,20}$/)
const model = z.object({
  model: z.string().regex(/^[\w.-]+$/),
  reasoning: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
}).strict()

const configSchema = z.object({
  dataDirectory: z.string().min(1),
  timezone: z.string().refine(value => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Use an IANA timezone such as Asia/Shanghai'),
  dashboardPort: z.number().int().min(1024).max(65535),
  discord: z.object({
    allowedUser: z.union([discordId, z.literal('')]),
    allowedChannels: z.array(discordId),
  }).strict(),
  codex: z.object({
    executable: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(600000),
    chat: model,
    memory: model,
  }).strict(),
}).strict()

export type Config = z.infer<typeof configSchema>
export type ModelSettings = z.infer<typeof model>

export function loadConfig() {
  const project = fileURLToPath(new URL('../../', import.meta.url))
  const local = resolve(project, 'soxin.local.json')
  const path = resolve(process.env.SOXIN_CONFIG ?? (existsSync(local) ? local : resolve(project, 'soxin.example.json')))
  const result = configSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!result.success) {
    throw new Error(result.error.issues.map(issue => issue.path.join('.') + ' — ' + issue.message).join('\n'))
  }
  return { ...result.data, dataDirectory: resolve(dirname(path), result.data.dataDirectory) }
}

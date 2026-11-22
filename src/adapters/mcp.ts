import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { domainSchema, querySchema, recordSchemas } from '../shared/records.ts'
import { RecordConflict, RecordMissing, RecordStore } from '../storage/records.ts'
import { loadConfig } from '../service/config.ts'

const id = z.uuid().describe('Record ID returned by list_records or create_record.')
const revision = z.number().int().positive().describe('Current revision returned by get_record or list_records.')
const data = z.union([recordSchemas.profile, recordSchemas.diet, recordSchemas.finance, recordSchemas.workout, recordSchemas.activity])

function result(operation: () => unknown) {
  try {
    const value = operation()
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { result: value } }
  } catch (reason) {
    const message = reason instanceof RecordConflict || reason instanceof RecordMissing
      ? reason.message
      : reason instanceof z.ZodError
        ? reason.issues.map(issue => issue.path.join('.') + ' — ' + issue.message).join('\n')
        : 'Could not complete the record operation'
    return { isError: true, content: [{ type: 'text' as const, text: message }] }
  }
}

function createServer(store: RecordStore) {
  const server = new McpServer({ name: 'soxin-records', version: '0.1.0' })
  server.registerTool('list_records', {
    description: 'List SoXin records. Profile lists current facts by default. Use filters.history for past versions, filters.field for an exact profile field, and filters.kind, month, or currency for finance.',
    inputSchema: z.strictObject({ domain: domainSchema, filters: querySchema.optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ domain, filters }) => result(() => store.list(domain, filters)))

  server.registerTool('get_record', {
    description: 'Read a SoXin record by its stable ID, including its editable data and current revision.',
    inputSchema: z.strictObject({ domain: domainSchema, id }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, args => result(() => {
    const entry = store.get(args.domain, args.id)
    if (!entry) throw new RecordMissing('This entry no longer exists')
    return entry
  }))

  server.registerTool('create_record', {
    description: 'Create a record in the requested domain. Creating a current profile fact archives the previous current value. Finance amountMinor uses currency minor units, such as 1250 for CNY 12.50.',
    inputSchema: z.strictObject({ domain: domainSchema, data }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, args => result(() => store.create(args.domain, args.data)))

  server.registerTool('update_record', {
    description: 'Replace a record’s editable fields using its current revision. Fetch the record first. Replacing a current profile value returns its successor record.',
    inputSchema: z.strictObject({ domain: domainSchema, id, revision, data }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, args => result(() => store.update(args.domain, args.id, args.revision, args.data)))

  server.registerTool('delete_record', {
    description: 'Permanently delete a record with its current revision.',
    inputSchema: z.strictObject({ domain: domainSchema, id, revision }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, args => result(() => {
    store.delete(args.domain, args.id, args.revision)
    return { deleted: true }
  }))
  return server
}

async function start() {
  const store = new RecordStore(loadConfig().dataDirectory)
  const server = createServer(store)
  const transport = new StdioServerTransport()
  const close = () => {
    store.close()
    void server.close()
  }
  process.stdin.once('end', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await server.connect(transport)
}

await start().catch(() => {
  console.error('SoXin MCP could not start. Check SOXIN_CONFIG and the data directory.')
  process.exitCode = 1
})

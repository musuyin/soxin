import { z } from 'zod'
import { currencySchema, dateSchema, domainSchema, financeKind, monthSchema } from '../shared/records.ts'
import type { AnyEntry } from '../shared/records.ts'

export type TurnInput = {
  sourceId: string
  channelId: string
  userId: string
  timestamp: string
  text: string
  images: readonly string[]
}
export interface ChatRunner {
  reply(input: TurnInput, memory: readonly AnyEntry[], sessionId?: string): Promise<{ text: string, sessionId: string }>
}
export interface MemoryRunner {
  retrieve(input: TurnInput, calendar: Calendar): Promise<unknown>
  extract(input: TurnInput, calendar: Calendar): Promise<unknown>
}
export class RunnerFailure extends Error {}
export type Calendar = { today: string, yesterday: string, tomorrow: string, timezone: string }

const day = z.union([dateSchema, z.enum(['today', 'yesterday', 'tomorrow'])])
const short = z.string().trim().min(1).max(120)
const long = z.string().trim().min(1).max(2000)
const amount = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/)

export const retrievalSchema = z.strictObject({
  queries: z.array(z.strictObject({
    domain: domainSchema, from: day.nullable(), to: day.nullable(), text: short.nullable(),
    field: short.nullable(), month: monthSchema.nullable(), currency: currencySchema.nullable(),
    kind: financeKind.nullable(), historical: z.boolean(), limit: z.number().int().min(1).max(8),
  })).max(5),
})

const selector = z.strictObject({ date: day.nullable(), text: short.nullable() }).nullable()
export const extractionSchema = z.strictObject({
  proposals: z.array(z.union([
    z.strictObject({ domain: z.literal('profile'), field: short, tag: short, description: long }),
    z.strictObject({
      domain: z.literal('diet'), target: selector, mealDate: day.nullable(), mealType: short.nullable(),
      description: long.nullable(), calories: z.number().int().nonnegative().max(100000).nullable(),
    }),
    z.strictObject({
      domain: z.literal('finance'), kind: financeKind, month: monthSchema, currency: currencySchema.nullable(),
      basis: z.enum(['monthly-total', 'monthly-breakdown', 'individual-payment']),
      total: amount.nullable(),
      details: z.array(z.strictObject({ label: short, amount: amount.nullable() })).max(50),
    }),
    z.strictObject({
      domain: z.literal('workout'), target: selector, workoutDate: day.nullable(),
      part: short.nullable(), description: long.nullable(),
    }),
    z.strictObject({
      domain: z.literal('activity'), target: selector, eventDate: day.nullable(), approximateTime: long.nullable(),
      event: short.nullable(), withWho: long.nullable(), location: long.nullable(), note: long.nullable(),
    }),
  ])).max(12),
})

export type Proposal = z.infer<typeof extractionSchema>['proposals'][number]
export const outputSchemas = {
  retrieve: z.toJSONSchema(retrievalSchema, { io: 'input', unrepresentable: 'any' }),
  extract: z.toJSONSchema(extractionSchema, { io: 'input', unrepresentable: 'any' }),
}

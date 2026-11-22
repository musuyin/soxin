import { z } from 'zod'

export const domains = ['profile', 'diet', 'finance', 'workout', 'activity'] as const
export const domainSchema = z.enum(domains)
export type Domain = z.infer<typeof domainSchema>

const text = z.string().trim().min(1, 'Enter a value').max(2000)
const shortText = text.max(120)
const optionalText = z.string().trim().max(2000).nullable()
export const dateSchema = z.iso.date()
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
export const currencySchema = z.string().trim().toUpperCase().pipe(z.string().refine(
  code => currencies.has(code), 'Use a supported ISO currency code',
))
const currencies = new Set(Intl.supportedValuesOf('currency'))
const minorAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const financeKind = z.enum(['income', 'expense'])

export const recordSchemas = {
  profile: z.strictObject({
    field: shortText, tag: shortText, description: text, archived: z.boolean(),
  }),
  diet: z.strictObject({
    mealDate: dateSchema, mealType: shortText, description: text,
    calories: z.number().int().nonnegative().max(100000).nullable(),
  }),
  finance: z.strictObject({
    kind: financeKind, month: monthSchema, currency: currencySchema.default('CNY'), amountMinor: minorAmount,
    details: z.array(z.strictObject({ label: shortText, amountMinor: minorAmount.nullable() })).max(50),
  }),
  workout: z.strictObject({
    workoutDate: dateSchema, part: shortText, description: text,
  }),
  activity: z.strictObject({
    eventDate: dateSchema.nullable(), approximateTime: optionalText,
    event: shortText, withWho: optionalText, location: optionalText, note: optionalText,
  }),
}

type Records = { [D in Domain]: z.infer<(typeof recordSchemas)[D]> }
export type RecordData<D extends Domain = Domain> = Records[D]
export type Entry<D extends Domain = Domain> = {
  id: string
  createdAt: string
  updatedAt: string
  revision: number
  domain: D
  data: RecordData<D>
}
export type AnyEntry = { [D in Domain]: Entry<D> }[Domain]

export function parseRecord<D extends Domain>(domain: D, data: unknown): RecordData<D> {
  return recordSchemas[domain].parse(data) as RecordData<D>
}

export const querySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  text: shortText.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  field: shortText.optional(),
  history: z.enum(['current', 'all', 'archived']).default('current'),
  month: monthSchema.optional(),
  currency: currencySchema.optional(),
  kind: financeKind.optional(),
}).refine(value => !value.from || !value.to || value.from <= value.to, 'Start date must precede end date')
export type RecordQuery = z.input<typeof querySchema>

export function fieldKey(field: string) {
  return field.normalize('NFKC').toLowerCase().trim()
}

function decimalPlaces(currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
}

export function parseMoney(value: string, currency: string) {
  const digits = decimalPlaces(currencySchema.parse(currency))
  const match = /^(\d{1,16})(?:\.(\d+))?$/.exec(value.trim())
  if (!match || (match[2]?.length ?? 0) > digits) {
    throw new Error(digits ? 'Enter an amount with up to ' + digits + ' decimal places' : 'Enter a whole amount')
  }
  const minor = BigInt(match[1] + (match[2] ?? '').padEnd(digits, '0'))
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large')
  return Number(minor)
}

export function moneyDecimal(amount: number, currency: string) {
  const digits = decimalPlaces(currency)
  if (!digits) return String(amount)
  const padded = String(amount).padStart(digits + 1, '0')
  return padded.slice(0, -digits) + '.' + padded.slice(-digits)
}

export function localDay(timestamp: string | Date, timezone: string, offset = 0) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const get = (type: string) => parts.find(part => part.type === type)?.value
  const midnight = new Date(get('year') + '-' + get('month') + '-' + get('day') + 'T00:00:00Z')
  midnight.setUTCDate(midnight.getUTCDate() + offset)
  return midnight.toISOString().slice(0, 10)
}

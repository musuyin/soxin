import { Activity, CircleUserRound, Dumbbell, LayoutGrid, Utensils, WalletCards } from 'lucide-react'
import type { AnyEntry } from '../../src/shared/records.ts'
import { moneyDecimal } from '../../src/shared/records.ts'

export const sections = {
  overview: { label: 'Overview', icon: LayoutGrid, singular: '' },
  profile: { label: 'Profile', icon: CircleUserRound, singular: 'profile fact' },
  diet: { label: 'Diet', icon: Utensils, singular: 'meal' },
  finance: { label: 'Finance', icon: WalletCards, singular: 'monthly total' },
  workout: { label: 'Workout', icon: Dumbbell, singular: 'workout' },
  activity: { label: 'Activity', icon: Activity, singular: 'activity' },
}

export function entryTitle(entry: AnyEntry) {
  switch (entry.domain) {
    case 'profile': return entry.data.field
    case 'diet': return entry.data.mealType
    case 'finance': return entry.data.currency + ' ' + moneyDecimal(entry.data.amountMinor, entry.data.currency)
    case 'workout': return entry.data.part
    case 'activity': return entry.data.event
  }
}

export function entryDescription(entry: AnyEntry) {
  switch (entry.domain) {
    case 'profile': return entry.data.tag + (entry.data.archived ? ' · Archived' : '')
    case 'diet': return entry.data.mealDate + (entry.data.calories === null ? '' : ' · ' + entry.data.calories + ' kcal')
    case 'finance': return entry.data.month + ' · ' + (entry.data.kind === 'income' ? 'Income' : 'Expenses')
    case 'workout': return entry.data.workoutDate
    case 'activity': return [entry.data.eventDate, entry.data.approximateTime, entry.data.location].filter(Boolean).join(' · ') || 'Date unspecified'
  }
}

export function auditDate(timestamp: string, timezone: string) {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(timestamp))
}

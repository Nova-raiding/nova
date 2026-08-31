import { bench, describe } from 'vitest'
import { mergeKnowledgeHydrationEvents } from './knowledge-hydration-checkpoint.js'

const snapshot = Array.from({ length: 20_000 }, (_, index) => ({ id: `evt-${index}`, value: 'snapshot' }))
const delta = Array.from({ length: 5_000 }, (_, index) => ({ id: `evt-${15_000 + index}`, value: 'delta' }))

function legacyMerge<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]) {
  const all = [...existing, ...incoming]
  return all.filter((event, index) => all.findIndex(candidate => candidate.id === event.id) === index)
}

describe('knowledge hydration event merge benchmark', () => {
  bench('optimized Set-based merge', () => {
    mergeKnowledgeHydrationEvents(snapshot, delta)
  })

  bench('legacy findIndex merge', () => {
    legacyMerge(snapshot, delta)
  })
})

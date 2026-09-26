import type { InvariantMutation } from './registry.js'

export const mutations: InvariantMutation[] = [
  {
    id: 'platform-rule-sync-platform-field',
    invariant:
      'A signed public platform rule is matched to its platform regardless of whether the platform travels in targetId or in scopeValue.',
    chokepoint: 'packages/review/src/platform-rule-sync.ts',
    chokepointSymbol: 'platformRuleSyncStatus',
    file: 'packages/review/src/platform-rule-sync.ts',
    find: '(rule.targetId ?? rule.scopeValue) === source.platform',
    replace: 'rule.targetId === source.platform',
    evidence: 'packages/review/src/platform-rule-sync.test.ts',
    overRejection: {
      find: 'const platformRules = manifestConfigured ? [...trustedManualRules, ...verifiedSignedRules] : trustedManualRules',
      replace: 'const platformRules = []',
      why: 'rejecting every imported platform rule reports every platform `not_configured`; the signed scopeValue and approved manual fixtures must continue to catch that outage',
    },
    evidenceFailsWith: 'finds a signed public rule that carries its platform only in scopeValue',
    uniqueness: {
      callers: ['apps/api/src/server.ts'],
      noSecondImplementation: [
        {
          pattern: 'targetId\\s*===',
          sample: 'rule.targetId === source.platform',
          allow: ['packages/review/src/platform-rule-sync.ts'],
          why: 'a platform rule names its platform in either `targetId` or `scopeValue`; matching one field somewhere else is the second implementation that reported every platform `not_configured` after a successful signed import',
        },
      ],
    },
    rationale:
      'This is the regression that shipped: the shared platform table projects `NULL::text AS target_id, platform AS scope_value`, so a signed import has scopeValue set and no targetId. Matching on targetId alone reported every platform `not_configured` after a successful import, and the production generation preflight 503s on exactly that state. Confirmed by mutation before this row existed.',
  },
]

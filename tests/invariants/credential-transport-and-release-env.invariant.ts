import type { InvariantFragment } from './registry.js'

/**
 * Two invariants that both failed the same way: the guard existed, the fix
 * landed at one call site, and the property the guard was supposed to prove
 * lived somewhere the guard could not see it.
 *
 *  1. "A platform credential must never appear in a request URL." The read path
 *     was repaired by moving the signed parameter set — access token, app key,
 *     signature — into the query string, because a signed body on the GET that
 *     `syncProducts` dispatched is refused by `fetch` before DNS. That made the
 *     read path the one place in the system that published a live credential to
 *     every hop that logs a request line.
 *
 *     The repair is POST because the *platforms* accept POST for these calls,
 *     not because our own write path happens to use it. An argument from our own
 *     code cannot establish that a third party will take the request: "reads and
 *     writes share `api.baseUrl`" says nothing about the method, "`.get` APIs are
 *     already POSTed by the write path" only proves we did it and did not notice
 *     a failure, and "a GET has no body" is the premise restated. What actually
 *     holds the conclusion up is each gateway's own documentation:
 *
 *       - Alibaba TOP (`open.taobao.com` doc 101617, "API调用方法详解"): every
 *         API accepts POST; GET is available only while the assembled URL stays
 *         under 1024 characters, and write APIs are POST-only. A read sent as
 *         POST is therefore a documented call shape, and one whose parameter set
 *         — token included — can be as long as it needs to be.
 *       - JD 宙斯 (`jos.jd.com/commondoc?listId=33`): modifying APIs are
 *         POST-only and query APIs accept both GET and POST, with POST
 *         recommended; the documented non-SDK example is
 *         `POST https://api.jd.com/routerjson` with
 *         `Content-Type: application/x-www-form-urlencoded`.
 *       - Pinduoduo: a single router endpoint takes every parameter as a POST
 *         form body (`application/x-www-form-urlencoded`); POST is the standard
 *         and only shape for `client_id`/`access_token`/`sign`/`type`.
 *
 *     The transport is *also* forced from below, which is the one line of
 *     evidence that comes from this repository: `applySignedRequest` refuses a
 *     bodyless method outright, so POST plus a form body is the only shape in
 *     which the signed set is not in the URL. And the flip is conditional on the
 *     signer actually carrying the credential: `xiaohongshu` and `douyin` are
 *     bearer signers whose parameter set is empty and whose token travels in
 *     `authorization`, so POSTing them buys nothing and changes a live wire
 *     shape. The two rows below pin that half of the sentence too.
 *
 *  2. "Every `${VAR:?}` variable of every production Compose layer has a
 *     producer an operator can find." The gate that claimed to check this read
 *     only the release layer and counted a bare `.env.example` key as a
 *     producer, so deleting the preflight half of the fix left it green while 16
 *     required variables in the base layers had no producer at all. Both halves
 *     now live behind one oracle (`tests/invariants/release-env-closure.ts`), and
 *     the evidence renders the real chain from exactly what that oracle declares.
 */
/**
 * The two non-production files that legitimately contain this file's own rule
 * text, named explicitly rather than exempted by directory.
 *
 * A rule has to match its own `sample` (`ruleMatchesItsSample`), so the
 * fragment that declares it necessarily matches the rule it declares. And the
 * evidence file reads `signedParametersCarryCredential` to assert that the
 * dispatched method follows the signer — that read *is* the review point, so it
 * is not a second implementation of the transport decision. Both are listed per
 * rule instead of allowing `tests/invariants` wholesale, so a file that joins
 * either contract later still fails the audit.
 */
const RULE_DECLARATION_SITE = 'tests/invariants/credential-transport-and-release-env.invariant.ts'
const RULE_EVIDENCE = 'tests/credential-transport.invariant.test.ts'

export const mutations: InvariantFragment['mutations'] = [
  {
    id: 'credential-transport-signed-set-in-url',
    invariant: 'A platform credential signed into a request never travels in the request URL.',
    chokepoint: 'packages/connectors/src/platform-adapters/signed-request.ts',
    chokepointSymbol: 'applySignedRequest',
    file: 'packages/connectors/src/platform-adapters/signed-request.ts',
    find: '  request.body = new URLSearchParams(params).toString()',
    replace: '  request.url = `${request.url}?${new URLSearchParams(params).toString()}`',
    evidence: 'tests/credential-transport.invariant.test.ts',
    overRejection: {
      find: '  if (isBodylessMethod(request.method)) {',
      replace: '  if (true) {',
      why: 'Refusing every signed request — body-carrying ones included — is the mirror defect of accepting the URL transport: the guard decides how the signed set travels, not whether the operation may run at all. An evidence file that only asserted "the query is empty" would still be satisfied by a chokepoint that never signs anything.',
    },
    evidenceFailsWith: 'reads are POSTed with the credential in the signed body',
    uniqueness: {
      // Every production file that names the symbol. The three router signers
      // call it; `http-connector.ts` and `types.ts` name it in prose that points
      // a reader at the single enforcement point, which is why they are listed
      // rather than merely tolerated — a fourth file that starts naming it has
      // joined the chokepoint's contract and must be re-audited.
      callers: [
        'packages/connectors/src/platform-adapters/jd.ts',
        'packages/connectors/src/platform-adapters/alibaba-top.ts',
        'packages/connectors/src/platform-adapters/pinduoduo.ts',
        'packages/connectors/src/http-connector.ts',
        'packages/connectors/src/types.ts',
      ],
      noSecondImplementation: [
        {
          pattern: 'request\\.url = ',
          sample: 'request.url = url.toString()',
          allow: ['packages/connectors/src/platform-adapters/signed-request.ts', RULE_DECLARATION_SITE],
          why: 'writing the request URL is the transport decision itself; a second file that assembles a signed request URL has left the chokepoint.',
        },
        {
          pattern: 'url\\.search = ',
          sample: "url.search = ''",
          allow: ['packages/connectors/src/platform-adapters/signed-request.ts', RULE_DECLARATION_SITE],
          why: 'placing or clearing the query of a signed request is the other half of the same decision — the pre-fix code was exactly `url.searchParams.set(key, value)` plus an assignment here.',
        },
        {
          pattern: 'params\\.(access_token|session|client_id|app_key) = ',
          sample: 'params.access_token = request.credential.accessToken',
          allow: [
            'packages/connectors/src/platform-adapters/jd.ts',
            'packages/connectors/src/platform-adapters/alibaba-top.ts',
            'packages/connectors/src/platform-adapters/pinduoduo.ts',
            RULE_DECLARATION_SITE,
          ],
          why: 'folding the credential into the signed parameter set is what makes the URL transport unacceptable. A fourth file that does it must declare `signedParametersCarryCredential` so its read is dispatched with a body, and must be added here.',
        },
      ],
    },
    rationale: 'This is the exact regression the read path shipped: instead of the urlencoded form body, the signed set is appended to the URL, where `access_token`/`session`, `app_key`/`client_id` and `sign` are recorded by the platform gateway, any host proxy, and any request-URL log or APM span. A source-string assertion cannot see it — only signing a real request with the real signer and reading the URL that reaches `fetch` can.',
  },
  {
    id: 'credential-transport-read-dispatched-bodyless',
    invariant: 'A read whose signer folds the credential into its signed parameter set is dispatched with a body-carrying method, because a bodyless one has no transport for that set except the URL.',
    chokepoint: 'packages/connectors/src/http-connector.ts',
    chokepointSymbol: 'HttpPlatformConnector.syncProducts',
    file: 'packages/connectors/src/http-connector.ts',
    find: "const readMethod = config.signer?.signedParametersCarryCredential === true ? 'POST' : 'GET'",
    replace: "const readMethod = 'GET'",
    evidence: 'tests/credential-transport.invariant.test.ts',
    overRejection: {
      find: "const readMethod = config.signer?.signedParametersCarryCredential === true ? 'POST' : 'GET'",
      replace: "const readMethod = (() => { throw new Error('the read path refuses this request') })()",
      why: 'Refusing the read outright is the mirror of dispatching it without a transport for the credential: an evidence file that only observed "the credential is not in the URL" would pass a connector that no longer dispatches anything, so the same run has to fail here too.',
    },
    evidenceFailsWith: 'dispatches its read with the transport its credential actually needs',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "signedParametersCarryCredential[^\\n]*\\?\\s*'POST'\\s*:\\s*'GET'|'sync_products'\\s*,\\s*'(?:GET|HEAD|POST)'",
          sample: "const readMethod = config.signer?.signedParametersCarryCredential === true ? 'POST' : 'GET'",
          allow: ['packages/connectors/src/http-connector.ts', RULE_DECLARATION_SITE],
          why: 'the read is dispatched with a method derived from the signer. A literal method next to the `sync_products` operation anywhere else is a second transport decision, which is how the flip escaped onto the bearer platforms the first time.',
        },
        {
          pattern: 'signedParametersCarryCredential === true',
          sample: 'config.signer?.signedParametersCarryCredential === true',
          allow: ['packages/connectors/src/http-connector.ts', RULE_DECLARATION_SITE, RULE_EVIDENCE],
          why: 'one expression decides whether this read needs a body. A second comparison of the same property somewhere else can disagree with this one, and the two reads then travel under different methods for the same credential shape.',
        },
      ],
    },
    rationale: 'The GET dispatch is what forced the credentials into the query in the first place, so this is the exact line the repair had to change. Reverting it makes `applySignedRequest` refuse (terminal `NOT_CONFIGURED`) rather than re-publish the token, so the read path stops working instead of silently leaking. The evidence names that reason rather than merely observing a rejection: the family-independent case reads where the credential actually landed on the wire off the dispatched request, and fails because the method and the credential no longer match — the same assertion a leak would fail, which is what stops it certifying "the read broke" as "the credential was protected".',
  },
  {
    id: 'credential-transport-bearer-read-flipped-to-post',
    invariant: 'A read whose signer keeps the credential in the authorization header is left on the GET its platform is called with: flipping it to POST buys no security and changes a live wire shape nobody verified.',
    chokepoint: 'packages/connectors/src/http-connector.ts',
    chokepointSymbol: 'HttpPlatformConnector.syncProducts',
    file: 'packages/connectors/src/http-connector.ts',
    find: "const readMethod = config.signer?.signedParametersCarryCredential === true ? 'POST' : 'GET'",
    replace: "const readMethod = 'POST'",
    evidence: 'tests/credential-transport.invariant.test.ts',
    overRejection: {
      find: "const readMethod = config.signer?.signedParametersCarryCredential === true ? 'POST' : 'GET'",
      replace: "const readMethod = (() => { throw new Error('the read path refuses this request') })()",
      why: 'Refusing every read, including the router reads that must be POSTed and the bearer reads that must stay GET, is the mirror of getting one family wrong: the invariant is symmetric ("the method follows the credential"), so its evidence has to fail in both directions.',
    },
    evidenceFailsWith: 'dispatches its read with the transport its credential actually needs',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "signedParametersCarryCredential[^\\n]*\\?\\s*'POST'\\s*:\\s*'GET'|'sync_products'\\s*,\\s*'(?:GET|HEAD|POST)'",
          sample: "const readMethod = config.signer?.signedParametersCarryCredential === true ? 'POST' : 'GET'",
          allow: ['packages/connectors/src/http-connector.ts', RULE_DECLARATION_SITE],
          why: 'a literal read method beside the `sync_products` operation elsewhere is a second place that decides this platform family\'s transport, which is exactly how a router fix reached the bearer platforms.',
        },
        {
          pattern: 'signedParametersCarryCredential === true',
          sample: 'config.signer?.signedParametersCarryCredential === true',
          allow: ['packages/connectors/src/http-connector.ts', RULE_DECLARATION_SITE, RULE_EVIDENCE],
          why: 'the bearer half of the same decision: a second comparison of this property can flip a family whose credential never reaches `applySignedRequest`, where the change removes no exposure and is not verified by anything.',
        },
      ],
    },
    rationale: 'The repair as first written chose POST at the shared call site, which flipped `xiaohongshu` and `douyin` too. Both are `createBearerSigner` — an empty parameter set, the token in `authorization`, `applySignedRequest` never reached — so their credential was never in a URL and the change removed no exposure. It did replace a GET with a bodyless POST carrying no content-type on two live read paths, with no test pinning the new shape and no evidence the endpoints accept it: a 4xx there surfaces as `REMOTE_ERROR` and would have reached production green. The invariant is symmetric — the read method must follow the credential, in both directions — so this row pins the bearer half.',
  },
  {
    id: 'release-env-preflight-declaration-removed',
    invariant: 'Every variable a production Compose layer requires by `${VAR:?}` is named by a repository preflight, so a missing value is reported before the render truncates its errors.',
    chokepoint: 'tests/invariants/release-env-closure.ts',
    chokepointSymbol: 'declaredProducers',
    file: 'infra/scripts/deploy-preflight-ecs.sh',
    find: ': "${PILOT_GATEWAY_IMAGE_REF:?PILOT_GATEWAY_IMAGE_REF is required}"',
    replace: '# PILOT_GATEWAY_IMAGE_REF declaration removed by the mutation gate',
    evidence: 'tests/release-env-closure.invariant.test.ts',
    overRejection: {
      file: 'tests/invariants/release-env-closure.ts',
      find: '  const inTemplate = envTemplateKeys()\n  return new Set([...preflightAssertions()].filter(name => inTemplate.has(name)))',
      replace: '  return new Set<string>()',
      why: 'declaring no producer at all is the mirror of accepting a blank one: a repository that names every variable correctly would be reported as unproduced and would not render, and the evidence has to fail here too',
    },
    ruleMutation: {
      file: 'tests/invariants/release-env-closure.ts',
      find: '  return new Set([...preflightAssertions()].filter(name => inTemplate.has(name)))',
      replace: '  return new Set([...envTemplateKeys()])',
      why: 'the weaker union rule — a template key alone counts as a producer — is what made the first closure gate report a closed loop while the render still exited 1; breaking the oracle this way must erase the detection, which is only true while the evidence reads the oracle instead of restating it',
    },
    evidenceFailsWith: 'have no operator-facing producer',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: '\\.\\.\\.preflightAssertions\\(\\)|\\.\\.\\.envTemplateKeys\\(\\)|requiredProductionVariables\\(\\)',
          sample: 'return new Set([...preflightAssertions()].filter(name => inTemplate.has(name)))',
          allow: [
            'tests/invariants/release-env-closure.ts',
            'tests/release-env-closure.invariant.test.ts',
            'tests/ecs-compose-release-gate.test.ts',
          ],
          includeTests: true,
          why: 'the producer rule is decided once, in the oracle; a gate that recomputes the intersection for itself is the second implementation that let a narrowed oracle stay undetected',
        },
      ],
    },
    rationale: 'The false green this registry exists for: deleting exactly these two preflight assertions (PILOT_GATEWAY_IMAGE_REF and MIGRATION_IMAGE_REF) while keeping `.env.example` left all six tests in tests/ecs-compose-release-gate.test.ts passing, because a bare template key counted as a producer. Under the both-halves oracle the key loses its producer and the render — not a string match — is what fails.',
  },
  {
    id: 'release-env-template-declaration-removed',
    invariant: 'Every variable a production Compose layer requires by `${VAR:?}` is declared in `.env.example`, the only deploy template an operator can build the host `.env` from.',
    chokepoint: 'tests/invariants/release-env-closure.ts',
    chokepointSymbol: 'declaredProducers',
    file: '.env.example',
    find: 'PILOT_GATEWAY_IMAGE_REF=',
    replace: '# PILOT_GATEWAY_IMAGE_REF removed by the mutation gate',
    evidence: 'tests/release-env-closure.invariant.test.ts',
    overRejection: {
      file: 'tests/invariants/release-env-closure.ts',
      find: '  const inTemplate = envTemplateKeys()\n  return new Set([...preflightAssertions()].filter(name => inTemplate.has(name)))',
      replace: '  return new Set<string>()',
      why: 'a repository that declares every variable correctly must still be reported as complete; an oracle that declares nothing at all is the mirror of one that accepts any blank key, and the render evidence has to catch it',
    },
    ruleMutation: {
      file: 'tests/invariants/release-env-closure.ts',
      find: "  return new Set([...readFileSync('.env.example', 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map(match => match[1]!))",
      replace: '  return new Set([...requiredProductionVariables().keys()])',
      why: 'a template scan that answers with the requirement itself — every `:?` variable counts as declared in `.env.example` — is the mirror of the union rule that let the first closure gate pass while the render exited 1. Breaking the template half this way must erase the detection for the row that removes a template key, which is only true while the evidence reads the oracle instead of restating it',
    },
    evidenceFailsWith: 'have no operator-facing producer',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: '\\.\\.\\.preflightAssertions\\(\\)|\\.\\.\\.envTemplateKeys\\(\\)|requiredProductionVariables\\(\\)',
          sample: 'return new Set([...envTemplateKeys()])',
          allow: [
            'tests/invariants/release-env-closure.ts',
            'tests/release-env-closure.invariant.test.ts',
            'tests/ecs-compose-release-gate.test.ts',
          ],
          includeTests: true,
          why: 'the deploy template is read by one oracle; a second reader that decides for itself which keys count re-introduces the drift between the template half and the preflight half',
        },
      ],
    },
    rationale: 'The mirror image of the row above, and the failure the operator actually hit: `.env.example` declared only 2 of the 8 pinned image refs, so a host `.env` built from the repository template still made `docker compose config` exit 1 on six missing `*_IMAGE_REF` values. A preflight assertion alone never reaches the `.env` the renderer reads.',
  },
]

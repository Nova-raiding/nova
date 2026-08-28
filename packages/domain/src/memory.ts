import type { FactField } from './facts.js'
import type { Task } from './task.js'
import type { ContentVersion } from './content-version.js'
import type { PublishJob } from './publish.js'

export interface DomainRepository {
  readonly facts: Map<string, FactField>
  readonly tasks: Map<string, Task>
  readonly contentVersions: Map<string, ContentVersion>
  readonly publishJobs: Map<string, PublishJob>
  readonly publishJobsByIdempotency: Map<string, PublishJob>
  readonly publishJobsByToken: Map<string, PublishJob>
}

export const createInMemoryDomainRepository = (): DomainRepository => ({
  facts: new Map(), tasks: new Map(), contentVersions: new Map(), publishJobs: new Map(), publishJobsByIdempotency: new Map(), publishJobsByToken: new Map(),
})

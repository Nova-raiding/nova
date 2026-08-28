export interface DomainRuntime {
  readonly now: () => string
  readonly nextId: (prefix: string) => string
}

let sequence = 0

export const systemRuntime: DomainRuntime = {
  now: () => new Date().toISOString(),
  nextId: (prefix) => `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`,
}

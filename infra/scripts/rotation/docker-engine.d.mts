export class DockerEngine {
  constructor(socketPath?: string, transport?: any)
  request(method: string, route: string, body?: unknown): Promise<any>
  inspect(id: string): Promise<any>
  inspectNetwork(name: string): Promise<any>
  create(name: string, spec: any): Promise<string>
  connect(id: string, name: string, endpoint: any): Promise<void>
  disableRestart(id: string): Promise<void>
  stop(id: string): Promise<void>
  start(id: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
  waitHealthy(id: string, deadlineMs?: number): Promise<void>
}

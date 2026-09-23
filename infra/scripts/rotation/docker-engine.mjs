import http from 'node:http'

const fail = code => { throw new Error(code) }
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
const validName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)

export class DockerEngine {
  constructor(socketPath = '/var/run/docker.sock', transport = http.request) {
    this.socketPath = socketPath
    this.transport = transport
  }

  request(method, route, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = this.transport({ socketPath: this.socketPath, method, path: `/v1.44${route}`, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, res => {
        const parts = []
        res.on('data', chunk => parts.push(chunk))
        res.on('end', () => {
          // Docker errors can echo an environment or mount path. Discard body.
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`DOCKER_HTTP_${res.statusCode}`))
          if (!parts.length) return resolve(undefined)
          try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) }
          catch { reject(new Error('DOCKER_INVALID_JSON')) }
        })
      })
      req.on('error', () => reject(new Error('DOCKER_IO_FAILURE')))
      if (payload) req.write(payload)
      req.end()
    })
  }

  async inspect(id) {
    if (!validId(id)) fail('INVALID_CONTAINER_ID')
    return this.request('GET', `/containers/${id}/json`)
  }

  async inspectNetwork(name) {
    if (!validName(name)) fail('INVALID_NETWORK_NAME')
    return this.request('GET', `/networks/${encodeURIComponent(name)}`)
  }

  async create(name, spec) {
    if (!validName(name)) fail('INVALID_CONTAINER_NAME')
    const { Config, HostConfig, NetworkingConfig } = spec
    if (!Config || !HostConfig || !NetworkingConfig) fail('INVALID_CLONE_SPEC')
    const response = await this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { ...Config, HostConfig, NetworkingConfig })
    if (!validId(response?.Id)) fail('INVALID_CREATED_ID')
    return response.Id
  }

  async connect(id, name, endpoint) {
    if (!validId(id) || !validName(name)) fail('INVALID_NETWORK_TARGET')
    await this.request('POST', `/networks/${encodeURIComponent(name)}/connect`, { Container: id, EndpointConfig: endpoint })
  }

  async disableRestart(id) {
    if (!validId(id)) fail('INVALID_CONTAINER_ID')
    await this.request('POST', `/containers/${id}/update`, { RestartPolicy: { Name: 'no' } })
  }

  async stop(id) {
    if (!validId(id)) fail('INVALID_CONTAINER_ID')
    await this.request('POST', `/containers/${id}/stop?t=20`)
  }

  async start(id) {
    if (!validId(id)) fail('INVALID_CONTAINER_ID')
    await this.request('POST', `/containers/${id}/start`)
  }

  async rename(id, name) {
    if (!validId(id) || !validName(name)) fail('INVALID_RENAME')
    await this.request('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`)
  }

  async remove(id) {
    if (!validId(id)) fail('INVALID_CONTAINER_ID')
    await this.request('DELETE', `/containers/${id}?v=false&force=false`)
  }

  async waitHealthy(id, deadlineMs = 90000) {
    const until = Date.now() + deadlineMs
    while (Date.now() < until) {
      const inspect = await this.inspect(id)
      if (inspect?.State?.Running !== true) fail('CONTAINER_NOT_RUNNING')
      if (inspect.State.Health?.Status === 'healthy') return
      if (inspect.State.Health?.Status === 'unhealthy') fail('CONTAINER_UNHEALTHY')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    fail('HEALTH_TIMEOUT')
  }
}

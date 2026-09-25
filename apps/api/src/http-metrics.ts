import type { IncomingMessage, ServerResponse } from 'node:http'

const metricsStartedAt = process.hrtime.bigint()
const metricRequests = new Map<string, number>()
let metricRequestCount = 0
let metricRequestDurationSeconds = 0
let metricInFlight = 0

export function observeHttpMetric(req: IncomingMessage, res: ServerResponse, startedAt: bigint, aborted = false) {
  // A socket destroyed before the response finished never had a status code, and
  // `res.statusCode` still reads the 200 default — so recording it counted every
  // client abort as a success and skewed the error-rate denominator. 499 is the
  // conventional "client closed request".
  const status = aborted && !res.writableFinished ? 499 : res.statusCode
  const key = `${req.method ?? 'UNKNOWN'}:${status}`
  metricRequests.set(key, (metricRequests.get(key) ?? 0) + 1)
  metricRequestCount += 1
  metricRequestDurationSeconds += Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
  metricInFlight = Math.max(0, metricInFlight - 1)
}

export function beginHttpMetric() { metricInFlight += 1 }

export function httpMetricLines(): string[] {
  return [
    '# HELP merchant_http_requests_total Total HTTP requests handled by status code.',
    '# TYPE merchant_http_requests_total counter',
    ...[...metricRequests.entries()].map(([key, value]) => {
      const [method, status] = key.split(':')
      return `merchant_http_requests_total{method="${method}",status="${status}"} ${value}`
    }),
    '# HELP merchant_http_request_duration_seconds_sum Total HTTP request duration in seconds.',
    '# TYPE merchant_http_request_duration_seconds_sum counter',
    `merchant_http_request_duration_seconds_sum ${metricRequestDurationSeconds}`,
    '# HELP merchant_http_request_duration_seconds_count Total HTTP request count used for the duration summary.',
    '# TYPE merchant_http_request_duration_seconds_count counter',
    `merchant_http_request_duration_seconds_count ${metricRequestCount}`,
    '# HELP merchant_http_inflight_requests Current in-flight HTTP requests.',
    '# TYPE merchant_http_inflight_requests gauge',
    `merchant_http_inflight_requests ${metricInFlight}`,
    '# HELP merchant_process_uptime_seconds Process uptime in seconds.',
    '# TYPE merchant_process_uptime_seconds gauge',
    `merchant_process_uptime_seconds ${Number(process.hrtime.bigint() - metricsStartedAt) / 1_000_000_000}`,
  ]
}

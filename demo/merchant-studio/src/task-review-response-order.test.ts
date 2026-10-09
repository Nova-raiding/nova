import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LatestRequestSequence } from './latest-request-sequence'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('task content review response ordering', () => {
  it('guards the independent version review handler with the shared request sequence', () => {
    const handler = app.slice(app.indexOf('const viewVersion ='), app.indexOf('const approve ='))
    expect(handler).toContain('contentReviewRequests.current.begin()')
    expect(handler).toContain('contentReviewRequests.current.isCurrent(reviewRequestId)')
  })

  it('ignores an older review response after the merchant switches versions', async () => {
    const sequence = new LatestRequestSequence()
    const displayedReports: string[] = []
    const oldReview = deferred<string>()
    const currentReview = deferred<string>()

    const oldRequestId = sequence.begin()
    const oldRequest = oldReview.promise.then((report) => {
      if (sequence.isCurrent(oldRequestId)) displayedReports.push(report)
    })
    const currentRequestId = sequence.begin()
    const currentRequest = currentReview.promise.then((report) => {
      if (sequence.isCurrent(currentRequestId)) displayedReports.push(report)
    })

    currentReview.resolve('version 2 report')
    await currentRequest
    oldReview.resolve('version 3 report')
    await oldRequest

    expect(displayedReports).toEqual(['version 2 report'])
  })
})

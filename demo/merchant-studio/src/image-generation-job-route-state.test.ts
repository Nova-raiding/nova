import { describe, expect, it } from 'vitest'
import {
  imageJobForRoute,
  isImageJobRequestCurrent,
  updateVisualRefsForRoute,
  visualRefsForRoute,
} from './image-generation-job-route-state.js'

describe('image generation route state', () => {
it('hides the old job and rejects a late response after the route changes', () => {
  const snapshot = { routeJobId: 'job-a', job: { jobId: 'job-a', state: 'failed' } }

  expect(imageJobForRoute(snapshot, 'job-a')?.jobId).toBe('job-a')
  expect(imageJobForRoute(snapshot, 'job-b')).toBeNull()
  expect(isImageJobRequestCurrent('job-a', 'job-b')).toBe(false)
  expect(isImageJobRequestCurrent('job-b', 'job-b')).toBe(true)
})

it('treats a workspace change as a different image job scope even when jobId is unchanged', () => {
  const oldWorkspaceSnapshot = { routeJobId: 'workspace-a:job-a', job: { jobId: 'job-a', state: 'succeeded' } }

  expect(imageJobForRoute(oldWorkspaceSnapshot, 'workspace-b:job-a')).toBeNull()
  expect(isImageJobRequestCurrent('workspace-a:job-a', 'workspace-b:job-a')).toBe(false)
})

it('does not carry selected visual refs between image job routes', () => {
  const selectedForA = updateVisualRefsForRoute(
    { routeJobId: 'job-a', refs: [] },
    'job-a',
    () => ['asset:a1', 'asset:a2'],
  )

  expect(visualRefsForRoute(selectedForA, 'job-b')).toEqual([])
  const selectedForB = updateVisualRefsForRoute(selectedForA, 'job-b', (refs) => [...refs, 'asset:b1'])
  expect(selectedForB).toEqual({ routeJobId: 'job-b', refs: ['asset:b1'] })
  expect(visualRefsForRoute(selectedForA, 'job-a')).toEqual(['asset:a1', 'asset:a2'])
})
})

export type ImageJobSnapshot<T> = { routeJobId: string; job: T } | null

export function imageJobForRoute<T>(snapshot: ImageJobSnapshot<T>, routeJobId: string): T | null {
  return snapshot?.routeJobId === routeJobId ? snapshot.job : null
}

export type VisualSelectionSnapshot = { routeJobId: string; refs: string[] }

export function visualRefsForRoute(snapshot: VisualSelectionSnapshot, routeJobId: string): string[] {
  return snapshot.routeJobId === routeJobId ? snapshot.refs : []
}

export function updateVisualRefsForRoute(
  snapshot: VisualSelectionSnapshot,
  routeJobId: string,
  update: (refs: string[]) => string[],
): VisualSelectionSnapshot {
  return { routeJobId, refs: update(visualRefsForRoute(snapshot, routeJobId)) }
}

export function isImageJobRequestCurrent(requestedRouteJobId: string, currentRouteJobId: string): boolean {
  return requestedRouteJobId === currentRouteJobId
}

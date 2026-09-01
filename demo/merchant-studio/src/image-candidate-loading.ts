export type ImageCandidateLoading = {
  loading: 'eager' | 'lazy'
  fetchPriority: 'high' | 'low' | 'auto'
}

/**
 * Keep the first candidate immediately visible, while allowing paginated and
 * below-the-fold candidates to yield network and decode work to the browser.
 * The gallery's 4:3 CSS box reserves space, so lazy loading cannot introduce
 * layout shift while the image is fetched.
 */
export function imageCandidateLoading(page: number, index: number): ImageCandidateLoading {
  const aboveFold = page === 1 && index === 0
  return aboveFold
    ? { loading: 'eager', fetchPriority: 'high' }
    : { loading: 'lazy', fetchPriority: 'low' }
}

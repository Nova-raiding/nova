type CapturePage = {
  viewportSize(): { width: number; height: number } | null
  url(): string
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>
}

export function createScreenshotMatrixEvidence(options: {
  evidenceDir: string
  matrixName: string
  cwd?: string
  now?: () => Date
}): Promise<{
  manifestPath: string
  capture(page: CapturePage, options: { filePath: string; label: string; fullPage?: boolean }): Promise<void>
  finalize(): Promise<unknown>
}>

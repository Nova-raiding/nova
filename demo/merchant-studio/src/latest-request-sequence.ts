/** Identifies the latest request in a replaceable view (for example, content review). */
export class LatestRequestSequence {
  private current = 0

  begin(): number {
    this.current += 1
    return this.current
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.current
  }

  invalidate(): void {
    this.current += 1
  }
}

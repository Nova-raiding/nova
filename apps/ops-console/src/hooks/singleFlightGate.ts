/** Prevents overlapping execution, including calls made in the same event turn. */
export class SingleFlightGate {
  private inFlight = false;

  run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.inFlight) return Promise.resolve(undefined);
    // Acquire synchronously, before invoking an operation that may open a dialog.
    this.inFlight = true;
    return Promise.resolve()
      .then(operation)
      .finally(() => { this.inFlight = false; });
  }
}

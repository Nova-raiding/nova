/** Prevent a second mutation from starting before the first one settles. */
export async function runSingleFlight(
  lock: { current: boolean },
  action: () => Promise<void>,
): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  try {
    await action();
  } finally {
    lock.current = false;
  }
}

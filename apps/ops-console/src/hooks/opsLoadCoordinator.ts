export class OpsLoadCoordinator {
  private latestRequest = 0;

  begin() {
    this.latestRequest += 1;
    return this.latestRequest;
  }

  isCurrent(request: number) {
    return request === this.latestRequest;
  }

  commit(request: number, update: () => void) {
    if (!this.isCurrent(request)) return false;
    update();
    return true;
  }
}

export function applyLoadedValue<T>(value: T | undefined, update: (loaded: T) => void) {
  if (value === undefined) return false;
  update(value);
  return true;
}

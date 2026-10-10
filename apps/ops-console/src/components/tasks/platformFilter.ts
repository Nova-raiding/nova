export function updatePlatformFilter<P extends string, T extends { platform?: P; accountId?: string }>(
  current: T,
  platform: P | undefined,
  stores: readonly { platform: string; accountId: string }[],
): Omit<T, "platform" | "accountId"> & { platform?: P; accountId?: string } {
  if (!platform || !current.accountId) return { ...current, platform };
  const accountMatchesPlatform = stores.some(
    (store) => store.accountId === current.accountId && store.platform === platform,
  );
  return {
    ...current,
    platform,
    ...(accountMatchesPlatform ? {} : { accountId: undefined }),
  };
}

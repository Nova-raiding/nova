export function opsPublicAsset(path: string, base = import.meta.env.BASE_URL): string {
  const normalizedBase = `${base || "/"}`.replace(/\/*$/u, "/");
  return `${normalizedBase}${path.replace(/^\/*/u, "")}`;
}

export const storeNovaLogoUrl = opsPublicAsset("assets/store-nova-primary-horizontal.png");

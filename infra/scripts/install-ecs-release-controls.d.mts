export const CONTROLS: Readonly<Record<string, Readonly<{ executable: string; digest: string }>>>;
export function prepareControlBytes(control: string, bytes: Buffer, sourceSha: string, nodePath: string): Buffer;
export function assertProtectedPath(path: string, owner?: number): void;
export function parseInstallArguments(args: string[]): Record<string, string>;

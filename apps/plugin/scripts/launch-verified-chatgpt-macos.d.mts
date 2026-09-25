export type ChatGPTVerification =
  | { ok: true; appPath?: string }
  | { ok: false; reason: string; missing?: boolean }

export type ChatGPTLaunchResult =
  | { launched: true }
  | { launched: false; reason: string }

type SpawnResult = {
  status: number | null
  error?: Error | null
}

type SpawnSyncLike = (
  command: string,
  args?: string[],
  options?: Record<string, unknown>,
) => SpawnResult

export function launchVerifiedChatGPT(
  appPath: string,
  options?: {
    spawn?: SpawnSyncLike
    verify?: (appPath: string) => ChatGPTVerification
  },
): ChatGPTLaunchResult

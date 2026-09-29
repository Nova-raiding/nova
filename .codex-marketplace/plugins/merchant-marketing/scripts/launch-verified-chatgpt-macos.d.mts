export function launchVerifiedChatGPT(
  appPath: string,
  options?: {
    spawn?: (command: string, args: string[], options: { stdio: 'ignore' }) => {
      status: number | null
      error?: Error
    }
    verify?: (appPath: string) => { ok: boolean; reason?: string }
  },
): { launched: boolean; reason?: string }

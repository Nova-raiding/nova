export const workspaceDirectoryStatuses = ['active', 'disabled'] as const
export type WorkspaceDirectoryStatus = (typeof workspaceDirectoryStatuses)[number]

export interface WorkspaceDirectoryQuery {
  query?: string
  status?: WorkspaceDirectoryStatus
  subscriptionStatus?: string
  offset: number
  limit: number
}

export interface WorkspaceDirectoryItem {
  workspaceId: string
  status: WorkspaceDirectoryStatus
  planName: string
  monthlyPriceCny: number
  usedTasks: number
  includedTasks: number
  subscriptionStatus: string
  memberCount: number
}

export interface WorkspaceDirectoryPage {
  items: WorkspaceDirectoryItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

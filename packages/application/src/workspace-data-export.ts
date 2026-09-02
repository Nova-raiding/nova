import type { WorkspaceDataExportRepository, WorkspaceDataExportRequest } from '../../persistence/src/workspace-data-export-repository.js'

export interface WorkspaceDataExportRecoveryView {
  schema_version: 'workspace-data-export.v1'
  request_id: string
  workspace_id: string
  scope: 'workspace'
  status: WorkspaceDataExportRequest['status']
  requested_at: string
  updated_at: string
  content_export_equivalent: false
  delivery: {
    available: boolean
    artifact_ref: string | null
    sha256: string | null
    size_bytes: number | null
    expires_at: string | null
  }
  next_actions: readonly string[]
}

function view(row: WorkspaceDataExportRequest): WorkspaceDataExportRecoveryView {
  const ready = row.status === 'ready'
  return {
    schema_version: 'workspace-data-export.v1',
    request_id: row.id,
    workspace_id: row.workspaceId,
    scope: 'workspace',
    status: row.status,
    requested_at: row.requestedAt,
    updated_at: row.updatedAt,
    content_export_equivalent: false,
    delivery: {
      available: ready,
      artifact_ref: ready ? row.artifactRef ?? null : null,
      sha256: ready ? row.artifactSha256 ?? null : null,
      size_bytes: ready ? row.artifactSizeBytes ?? null : null,
      expires_at: ready ? row.artifactExpiresAt ?? null : null,
    },
    next_actions: ready ? ['下载完整工作区数据导出'] : row.status === 'failed' ? ['重新提交工作区数据导出申请'] : ['稍后查询原导出申请'],
  }
}

export class WorkspaceDataExportService {
  constructor(private readonly repository: WorkspaceDataExportRepository) {}

  async request(input: { workspaceId: string; actorId: string; reason: string; idempotencyKey: string }): Promise<WorkspaceDataExportRecoveryView> {
    return view(await this.repository.request({ workspaceId: input.workspaceId, requestedBy: input.actorId, reason: input.reason, idempotencyKey: input.idempotencyKey }))
  }

  async get(input: { workspaceId: string; requestId: string }): Promise<WorkspaceDataExportRecoveryView | undefined> {
    const row = await this.repository.get(input.workspaceId, input.requestId)
    return row ? view(row) : undefined
  }
}

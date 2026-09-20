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

/**
 * A `ready` row only means the export ran; the artifact behind it is deleted
 * once `artifact_expires_at` passes (`workspace_data_export_requests` requires
 * that column for every ready row). Presenting an expired artifact as
 * `available: true` told the merchant to download a file that no longer
 * exists, so availability is derived from both the state and the expiry.
 */
function view(row: WorkspaceDataExportRequest, at: Date): WorkspaceDataExportRecoveryView {
  const artifactExpired = row.artifactExpiresAt !== undefined && Date.parse(row.artifactExpiresAt) <= at.getTime()
  const ready = row.status === 'ready' && !artifactExpired
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
    next_actions: ready
      ? ['下载完整工作区数据导出']
      : row.status === 'failed' || artifactExpired
        ? ['重新提交工作区数据导出申请']
        : ['稍后查询原导出申请'],
  }
}

export class WorkspaceDataExportService {
  constructor(private readonly repository: WorkspaceDataExportRepository, private readonly clock: () => Date = () => new Date()) {}

  async request(input: { workspaceId: string; actorId: string; reason: string; idempotencyKey: string }): Promise<WorkspaceDataExportRecoveryView> {
    return view(await this.repository.request({ workspaceId: input.workspaceId, requestedBy: input.actorId, reason: input.reason, idempotencyKey: input.idempotencyKey }), this.clock())
  }

  async get(input: { workspaceId: string; requestId: string }): Promise<WorkspaceDataExportRecoveryView | undefined> {
    const row = await this.repository.get(input.workspaceId, input.requestId)
    return row ? view(row, this.clock()) : undefined
  }
}

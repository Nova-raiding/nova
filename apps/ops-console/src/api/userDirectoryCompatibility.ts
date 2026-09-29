import type { OpsRequestError } from "../types/ops.js";

export type UserAccountType = "all" | "merchant" | "platform";
export type UserDirectoryFilters = {
  query?: string;
  status?: string;
  workspaceId?: string;
  accountType?: UserAccountType;
  page?: number;
  pageSize?: number;
};

export function userDirectoryParams(filters: UserDirectoryFilters) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 10;
  return {
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
    ...(filters.query?.trim() ? { query: filters.query.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    account_type: filters.accountType ?? "all",
    ...(filters.workspaceId?.trim() ? { workspace_id: filters.workspaceId.trim() } : {}),
  };
}

export function userDirectoryResultKey(filters: UserDirectoryFilters): string {
  return JSON.stringify(userDirectoryParams(filters));
}

/** Older API releases reject account_type as an unknown MCP parameter. */
export function isLegacyAccountTypeContractError(error: unknown): boolean {
  const candidate = error as Partial<OpsRequestError> | undefined;
  return candidate?.code === "INVALID_REQUEST"
    && /不接受参数\s*params\.account_type/u.test(candidate.message ?? "");
}

export class UnsupportedLegacyUserAccountFilterError extends Error {
  readonly code = "OPS_USERS_ACCOUNT_TYPE_FILTER_UNSUPPORTED";

  constructor() {
    super("当前运营 API 版本不支持筛选运营平台账号。请升级 API 后重试；未用商家数据替代运营账号结果。");
    this.name = "UnsupportedLegacyUserAccountFilterError";
  }
}

export async function loadUserDirectory<T>(
  request: (params: Record<string, string>) => Promise<T>,
  filters: UserDirectoryFilters,
): Promise<{ data: T; compatibilityWarning: string }> {
  const params = userDirectoryParams(filters);
  try {
    return { data: await request(params), compatibilityWarning: "" };
  } catch (error) {
    if (!isLegacyAccountTypeContractError(error)) throw error;
    if (filters.accountType === "platform") throw new UnsupportedLegacyUserAccountFilterError();

    const { account_type: _unsupported, ...legacyParams } = params;
    return {
      data: await request(legacyParams),
      compatibilityWarning: filters.accountType === "all"
        ? "当前运营 API 版本仅返回旧接口默认的商家成员范围；运营平台账号不在此结果中。升级 API 后可查看合并目录。"
        : "当前运营 API 版本使用旧的商家成员目录接口。",
    };
  }
}

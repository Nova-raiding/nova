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
    super("当前运营 API 版本不支持账号属性筛选。请将“属性”设为“全部”或升级 API 后重试；未用其他账号类别替代筛选结果。");
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
    if (filters.accountType && filters.accountType !== "all") throw new UnsupportedLegacyUserAccountFilterError();

    const { account_type: _unsupported, ...legacyParams } = params;
    return {
      data: await request(legacyParams),
      compatibilityWarning: "",
    };
  }
}

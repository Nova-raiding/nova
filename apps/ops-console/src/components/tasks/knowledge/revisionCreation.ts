export type RevisionCreationValues = {
  changesJson: string;
  reason: string;
};

export function parseRevisionChangesJson(value: string) {
  const source = value.trim();
  if (!source) throw new Error("请填写修正版变更 JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("变更内容必须是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("变更内容必须是 JSON 对象");
  if (Object.keys(parsed).length === 0)
    throw new Error("至少填写一个需要修改的字段");
  return parsed as Record<string, unknown>;
}

export async function submitRevisionCreation(
  input: ({ publishJobId: string } & RevisionCreationValues) | undefined,
  dependencies: {
    request: (params: { publish_job_id: string; changes_json: string; reason: string }) => Promise<unknown>;
    refresh: () => Promise<unknown>;
  },
) {
  if (!input) return { created: false as const, cancelled: true as const };
  const reason = input.reason.trim();
  if (!reason) throw new Error("请填写创建修正版的原因");
  const changes = parseRevisionChangesJson(input.changesJson);
  await dependencies.request({
    publish_job_id: input.publishJobId,
    changes_json: JSON.stringify(changes),
    reason,
  });
  await dependencies.refresh();
  return { created: true as const, cancelled: false as const };
}

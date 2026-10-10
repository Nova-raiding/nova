import { useLayoutEffect, useRef, useState } from "react";
import { Button, Checkbox, Input, Select, Space, Typography } from "antd";
import type { InputRef } from "antd";
import { parseCustomerDeliveryAccountBinding, type CustomerDeliveryAccount, type CustomerDeliveryAccountPage } from "../../api/customerDeliveryClient.js";
import { describeOpsError } from "../../api/opsClient.js";
import type { CustomerDeliveryRecord } from "./CustomerDeliverySection.js";

export function mergeCustomerDeliveryAccounts(current: CustomerDeliveryAccount[], incoming: CustomerDeliveryAccount[]) {
  const accounts = new Map(current.map((account) => [account.accountId, account]));
  for (const account of incoming) {
    const previous = accounts.get(account.accountId);
    if (previous && (previous.identityId !== account.identityId || previous.workspaceId !== account.workspaceId || previous.login !== account.login)) throw new Error("账号目录在查询期间发生变化，请重新查询并核对账号");
    if ([...accounts.values()].some((candidate) => candidate.identityId === account.identityId && candidate.accountId !== account.accountId)) throw new Error("账号目录包含冲突的身份，请重新查询");
    accounts.set(account.accountId, account);
  }
  return [...accounts.values()];
}

export function CustomerDeliveryAccountBinding({ record, disabled = false, readOnly = false, onList, onBind, onRefresh, onBound, onBusyChange }: {
  record: CustomerDeliveryRecord;
  disabled?: boolean;
  readOnly?: boolean;
  onList?: (input: { search?: string; cursor?: string }, signal: AbortSignal) => Promise<CustomerDeliveryAccountPage>;
  onBind?: (record: CustomerDeliveryRecord, account: CustomerDeliveryAccount, reason: string, signal: AbortSignal) => Promise<CustomerDeliveryRecord>;
  onRefresh?: (record: CustomerDeliveryRecord, signal: AbortSignal) => Promise<CustomerDeliveryRecord>;
  onBound: (record: CustomerDeliveryRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [loadedQuery, setLoadedQuery] = useState("");
  const [accounts, setAccounts] = useState<CustomerDeliveryAccount[]>([]);
  const [selection, setSelection] = useState<CustomerDeliveryAccount>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [searched, setSearched] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState<"search" | "refresh">("search");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"search" | "bind" | "refresh">();
  const reasonInput = useRef<InputRef>(null);
  const active = useRef<{ controller: AbortController; kind: "search" | "bind" | "refresh" } | undefined>(undefined);
  const mounted = useRef(false);
  const access = useRef({ disabled, readOnly, recordId: record.id });
  access.current = { disabled, readOnly, recordId: record.id };
  let binding: ReturnType<typeof parseCustomerDeliveryAccountBinding> | undefined;
  let bindingError = "";
  try { binding = parseCustomerDeliveryAccountBinding(record as unknown as Record<string, unknown>); }
  catch { bindingError = "生效账号关联信息不完整，请刷新档案核对；当前不可关联。"; }
  const writable = !disabled && !readOnly && !bindingError && !binding?.targetAccountId && Boolean(onList && onBind);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = undefined; onBusyChange?.(false); };
  }, []);
  useLayoutEffect(() => {
    active.current?.controller.abort(); active.current = undefined;
    setBusy(undefined); onBusyChange?.(false);
    setAccounts([]); setSelection(undefined); setNextCursor(undefined); setSearched(false);
    setQuery(""); setLoadedQuery(""); setReason(""); setConfirmed(false); setError(""); setNotice("");
  }, [record.id, writable]);
  const current = (controller: AbortController) => mounted.current && !controller.signal.aborted && active.current?.controller === controller && !access.current.disabled && !access.current.readOnly && access.current.recordId === record.id;
  const finish = (controller: AbortController) => {
    if (!current(controller)) return;
    active.current = undefined; setBusy(undefined); onBusyChange?.(false);
  };
  const search = async (more = false) => {
    if (!writable || !onList || active.current?.kind === "bind" || active.current?.kind === "refresh") return;
    active.current?.controller.abort();
    const controller = new AbortController(); active.current = { controller, kind: "search" };
    setBusy("search"); setError(""); setNotice(""); setConfirmed(false); setErrorAction("search");
    const searchQuery = more ? loadedQuery : query.trim();
    const cursor = more ? nextCursor : undefined;
    try {
      const result = await onList({ search: searchQuery || undefined, cursor }, controller.signal);
      if (!current(controller)) return;
      if (cursor && result.nextCursor === cursor) throw new Error("账号目录分页没有继续，请重新查询");
      const next = mergeCustomerDeliveryAccounts(more ? accounts : [], result.items);
      if (selection) mergeCustomerDeliveryAccounts([selection], next);
      setAccounts(next); setNextCursor(result.nextCursor); setLoadedQuery(searchQuery); setSearched(true);
    } catch (cause) { if (current(controller)) setError(`账号查询失败。${describeOpsError(cause)}`); }
    finally { finish(controller); }
  };
  const bind = async () => {
    if (!writable || !onBind || active.current || !selection) return;
    if (Array.from(reason.trim()).length < 3 || reason.trim().length > 1000) { setError("请填写 3–1000 字的关联原因"); reasonInput.current?.focus(); return; }
    if (!confirmed) { setError("请先核对账号并勾选关联确认"); return; }
    const controller = new AbortController(); active.current = { controller, kind: "bind" };
    setBusy("bind"); onBusyChange?.(true); setError(""); setNotice("");
    try {
      const updated = await onBind(record, selection, reason.trim(), controller.signal);
      if (!current(controller)) return;
      const result = parseCustomerDeliveryAccountBinding(updated as unknown as Record<string, unknown>);
      if (updated.id !== record.id || result.targetAccountId !== selection.accountId || result.targetIdentityId !== selection.identityId || !Number.isSafeInteger(updated.revision) || Number(updated.revision) <= Number(record.revision)) throw new Error("关联响应与所选账号或档案版本不一致，请刷新档案核对");
      onBound(updated);
      setNotice("账号已关联");
    } catch (cause) { if (current(controller)) { setError(`关联未确认成功。${describeOpsError(cause)} 请先刷新档案核对关联状态；确认仍未关联后，再重新查询并选择账号。`); setErrorAction("refresh"); } }
    finally { finish(controller); }
  };
  const refresh = async () => {
    if (!writable || !onRefresh || active.current) return;
    const controller = new AbortController(); active.current = { controller, kind: "refresh" };
    setBusy("refresh"); onBusyChange?.(true); setError(""); setNotice("");
    try {
      const updated = await onRefresh(record, controller.signal);
      if (!current(controller)) return;
      if (updated.id !== record.id || !Number.isSafeInteger(updated.revision) || Number(updated.revision) < 1) throw new Error("刷新结果与当前档案不匹配，请重新打开档案");
      onBound(updated);
      setAccounts([]); setSelection(undefined); setNextCursor(undefined); setSearched(false); setLoadedQuery(""); setConfirmed(false);
      setNotice(updated.targetAccountId ? "档案已刷新：该档案已有生效账号，请核对当前关联状态。" : "档案已刷新：请重新查询并选择账号，再次确认关联。");
    } catch (cause) { if (current(controller)) { setError(`刷新档案失败。${describeOpsError(cause)}`); setErrorAction("refresh"); } }
    finally { finish(controller); }
  };
  const cancel = () => {
    const kind = active.current?.kind;
    active.current?.controller.abort(); active.current = undefined; setBusy(undefined); onBusyChange?.(false);
    setNotice(kind === "bind" ? "已取消等待；如关联请求已送达，请刷新档案核对。取消不会撤销已保存的关联。" : kind === "refresh" ? "已取消档案刷新，可重新核对。" : "已取消账号查询，可重新查询。");
  };
  const options = selection && !accounts.some((account) => account.accountId === selection.accountId) ? [selection, ...accounts] : accounts;
  return <section aria-label="生效账号" style={{ width: "100%" }}>
    <Typography.Text strong>生效账号</Typography.Text>
    {bindingError ? <Typography.Paragraph type="danger" role="alert">{bindingError}</Typography.Paragraph> : binding?.targetAccountId ? <>
      <Typography.Paragraph style={{ margin: "8px 0", overflowWrap: "anywhere" }}>{binding.targetAccountLogin}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>已关联，仅此账号受该交付档案的完成状态约束。管理员停用、角色与付款限制仍独立生效；不能在此改绑。</Typography.Paragraph>
    </> : <>
      <Typography.Paragraph type="secondary" style={{ margin: "8px 0" }}>未关联。交付完成不代表账号已启用。</Typography.Paragraph>
      {writable ? <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <label htmlFor="delivery-account-search">查找商家登录账号</label>
          <Input.Search id="delivery-account-search" value={query} disabled={Boolean(busy)} aria-describedby={error && errorAction === "search" ? "delivery-account-error" : undefined} aria-invalid={Boolean(error && errorAction === "search")} placeholder="输入登录账号，或留空查询当前企业账号" enterButton="查询账号" onChange={(event) => {
            if (active.current?.kind === "search") { active.current.controller.abort(); active.current = undefined; setBusy(undefined); }
            // Results, selection, and cursor are scoped to the submitted query.
            // Once the text changes, keeping those controls visible can make an
            // old account look like a match for the new query (and still bindable).
            setAccounts([]); setSelection(undefined); setNextCursor(undefined);
            setLoadedQuery(""); setSearched(false); setError("");
            setQuery(event.target.value); setConfirmed(false);
          }} onSearch={() => void search()} loading={busy === "search"} />
        </div>
        <div>
          <label htmlFor="delivery-account-select">选择生效账号</label>
          <Select id="delivery-account-select" aria-label="选择生效账号" style={{ width: "100%" }} allowClear value={selection?.accountId} disabled={Boolean(busy)} placeholder="请查询后主动选择账号" options={options.map((account) => ({ value: account.accountId, label: account.login }))} onChange={(value) => { setSelection(options.find((account) => account.accountId === value)); setConfirmed(false); setError(""); }} notFoundContent={searched ? "没有找到可关联的商家账号，请调整查询或检查成员关系" : "请先查询账号"} />
          {searched && !accounts.length ? <Typography.Text type="secondary">没有找到可关联的商家账号，请调整查询或检查成员关系。</Typography.Text> : null}
          {nextCursor ? <Button size="small" disabled={Boolean(busy)} onClick={() => void search(true)}>加载更多账号</Button> : null}
        </div>
        {selection ? <>
          <div>
            <label htmlFor="delivery-account-reason">关联原因（必填）</label>
            <Input.TextArea ref={reasonInput} id="delivery-account-reason" value={reason} disabled={Boolean(busy)} rows={2} onChange={(event) => setReason(event.target.value)} aria-describedby="delivery-account-error" />
          </div>
          <Typography.Text type="secondary">关联后不可直接改绑。仅所选账号受交付完成门禁约束；不会解除管理员停用、角色或付款限制。</Typography.Text>
          <Checkbox checked={confirmed} disabled={Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)}>我已核对登录账号，确认关联 {selection.login}</Checkbox>
          <Button type="primary" loading={busy === "bind"} disabled={Boolean(busy) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1} onClick={() => void bind()}>确认关联账号</Button>
        </> : null}
        {busy ? <Space><Typography.Text role="status">{busy === "bind" ? "正在关联账号…" : busy === "refresh" ? "正在刷新档案…" : "正在查询账号…"}</Typography.Text><Button onClick={cancel}>{busy === "bind" ? "取消等待" : busy === "refresh" ? "取消刷新" : "取消查询"}</Button></Space> : null}
        {error ? <div id="delivery-account-error" role="alert"><Typography.Text type="danger">{error}</Typography.Text>{!busy && (errorAction !== "refresh" || onRefresh) ? <Button size="small" onClick={() => void (errorAction === "refresh" ? refresh() : search())}>{errorAction === "refresh" ? "刷新档案核对" : "重新查询"}</Button> : null}</div> : null}
        {notice ? <Typography.Text role="status">{notice}</Typography.Text> : null}
      </Space> : null}
    </>}
  </section>;
}

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCustomerDeliveryProfilePatch, customerDeliveryWorkspaceOptions, resolveCustomerDeliveryTargetWorkspaceId } from "./CustomerDeliveryPage.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

declare global {
  interface Window {
    __pendingDeliveryRequests(): Array<{ workspaceId: string; aborted: boolean }>;
    __resolveNextDeliveryRequest(records: Array<{ id: string; companyName: string; revision?: number }>): void;
    __pendingChecklistUpdates(): Array<{ workspaceId: string }>;
    __resolveNextChecklistUpdate(revision?: number): void;
    __pendingDeliveryDetails(): Array<{ workspaceId: string; aborted: boolean }>;
    __rejectNextDeliveryDetail(message: string): void;
    __revokeWorkspaceDirectory(): void;
    __revokeCustomerDeliveryRead(): void;
    __revokeCustomerDeliveryUpdate(): void;
    __switchDeliveryWorkspace(workspaceId: string): void;
  }
}

const pageSource = readFileSync(new URL("./CustomerDeliveryPage.tsx", import.meta.url), "utf8");

describe("customer delivery workspace selection", () => {
  it("labels workspaces with enterprise identity and blocks disabled workspaces", () => {
    expect(customerDeliveryWorkspaceOptions([
      { workspaceId: "ws_active", enterpriseName: "Store Nova测试商家", status: "active", planName: "专业版", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 100, subscriptionStatus: "active", memberCount: 1 },
      { workspaceId: "ws_disabled", enterpriseName: "已停用商家", status: "disabled", planName: "基础版", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 10, subscriptionStatus: "inactive", memberCount: 0 },
    ])).toEqual([
      { value: "ws_active", label: "Store Nova测试商家 · ws_active", disabled: false },
      { value: "ws_disabled", label: "已停用商家 · ws_disabled", disabled: true },
    ]);
  });

  it("provides an explicit accessible selector instead of an unactionable scope warning", () => {
    expect(pageSource).toContain('aria-label="客户交付目标企业工作区"');
    expect(pageSource).toContain("model.setAuthorizationTargetWorkspaceId");
    expect(pageSource).toContain('model.authorization.can("customer.delivery.update")');
    expect(pageSource).toContain("readOnly={!canWrite}");
    expect(pageSource).toContain('key={targetWorkspaceId || "unselected"}');
    expect(pageSource).toContain("setRecords([])");
  });

  it("never falls back to a locally remembered or session workspace", () => {
    expect(resolveCustomerDeliveryTargetWorkspaceId(undefined)).toBe("");
    expect(resolveCustomerDeliveryTargetWorkspaceId("  ")).toBe("");
    expect(resolveCustomerDeliveryTargetWorkspaceId("  ws_selected  ")).toBe("ws_selected");
    expect(pageSource).not.toContain("model.opsWorkspaceId?.trim()");
    expect(pageSource).not.toContain("model.opsSession?.workspace_id?.trim()");
    expect(pageSource).toContain('message="请选择目标企业工作区后开始客户交付"');
  });

  it("sends payment evidence as an array and explicitly clears a removed payment date", () => {
    const record: CustomerDeliveryRecord = { id: "delivery-1", companyName: "客户企业", paymentStatus: "unpaid", profile: true, integration: false, acceptance: false, training: false, videos: 0, paymentDate: "", paymentEvidenceRefs: [], contractFile: "asset:contract" };
    const cleared = JSON.parse(JSON.stringify(buildCustomerDeliveryProfilePatch(record)));
    expect(cleared).toMatchObject({ paymentDate: null, paymentEvidenceRefs: [], paymentStatus: "unpaid", contractRef: "asset:contract", customerProfileStatus: "complete" });
    expect(buildCustomerDeliveryProfilePatch({ ...record, paymentStatus: "paid", paymentDate: "2026-09-14", paymentEvidenceRefs: ["asset:payment"] })).toMatchObject({ paymentDate: "2026-09-14", paymentEvidenceRefs: ["asset:payment"] });
  });

  it("does not silently serialize a malformed payment evidence field", () => {
    const record = { id: "delivery-1", companyName: "客户企业", paymentStatus: "paid", profile: true, integration: false, acceptance: false, training: false, videos: 0, paymentEvidenceRefs: ["asset:payment", 3] } as unknown as CustomerDeliveryRecord;
    expect(() => buildCustomerDeliveryProfilePatch(record)).toThrow("付款凭证必须是有效素材编号数组");
  });
});

describe("customer delivery authorization revocation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-customer-delivery-revocation-"));
    const entryPath = "/__customer-delivery-revocation-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-customer-delivery-revocation",
        enforce: "pre",
        resolveId(id) {
          if (/\/api\/customerDeliveryClient\.(?:js|ts)$/u.test(id)) return "\0virtual:customer-delivery-client";
          if (/\/components\/delivery\/CustomerDeliverySection\.(?:js|tsx)$/u.test(id)) return "\0virtual:customer-delivery-section";
          if (id === entryPath) return `\0${entryPath}`;
        },
        load(id) {
          if (id === "\0virtual:customer-delivery-client") return `
            export const parseCustomerDeliveryEvidenceRefs = value => value ?? [];
            export const customerDeliveryClient = {
              list: (workspaceId, signal) => window.__queueDeliveryList(workspaceId, signal),
              get: (workspaceId, deliveryId, signal) => window.__queueDeliveryDetail(workspaceId, deliveryId, signal),
              create: async () => ({}), update: async () => ({}),
              updateChecklist: input => window.__queueChecklistUpdate(input), listChecklistItems: async () => [],
              completeTraining: async () => ({}), listVideos: async () => [], addVideo: async () => ({}),
              uploadAsset: async () => ({}), getAsset: async () => ({}),
            };
          `;
          if (id === "\0virtual:customer-delivery-section") return `
            import React from "react";
            export function CustomerDeliverySection({ disabled, readOnly, records, onChecklistSave, onAssetUpload }) {
              const [result, setResult] = React.useState("");
              return React.createElement("section", { "data-testid": "delivery-section", "data-read-only": String(readOnly), "data-has-upload": String(Boolean(onAssetUpload)) },
                React.createElement("button", { type: "button", disabled: disabled || readOnly, "aria-label": "新建客户" }, "新建客户"),
                React.createElement("button", { type: "button", disabled, "aria-label": "查看交付详情" }, "查看交付详情"),
                React.createElement("button", {
                  type: "button", disabled: disabled || readOnly || !records[0] || !onChecklistSave, "aria-label": "保存清单",
                  onClick: () => { setResult("保存中"); void onChecklistSave({
                    record: records[0], checklistKey: "system_integration",
                    items: [{ itemKey: "api", completed: true, evidenceAssetRefs: ["asset:evidence"] }],
                  }).then(() => setResult("保存成功"), () => setResult("保存失败")); },
                }, "保存清单"),
                React.createElement("output", null, result),
                ...records.map(record => React.createElement("span", { key: record.id }, record.companyName))
              );
            }
          `;
          if (id !== `\0${entryPath}`) return;
          return `
            import React from "react";
            import { createRoot } from "react-dom/client";
            import { App } from "antd";
            import { CustomerDeliveryPage } from "/src/pages/CustomerDeliveryPage.tsx";

            const capabilities = new Set(["customer.delivery.read", "customer.delivery.update", "workspace.directory.read"]);
            const pending = [];
            const pendingUpdates = [];
            const pendingDetails = [];
            window.__queueDeliveryList = (workspaceId, signal) => new Promise(resolve => pending.push({ workspaceId, signal, resolve }));
            window.__pendingDeliveryRequests = () => pending.map(request => ({ workspaceId: request.workspaceId, aborted: request.signal.aborted }));
            window.__resolveNextDeliveryRequest = records => pending.shift()?.resolve(records);
            window.__queueChecklistUpdate = input => new Promise((resolve, reject) => pendingUpdates.push({ workspaceId: input.targetWorkspaceId, resolve, reject }));
            window.__pendingChecklistUpdates = () => pendingUpdates.map(request => ({ workspaceId: request.workspaceId }));
            window.__resolveNextChecklistUpdate = (revision = 2) => pendingUpdates.shift()?.resolve({ items: [], revision });
            window.__queueDeliveryDetail = (workspaceId, deliveryId, signal) => new Promise((resolve, reject) => pendingDetails.push({ workspaceId, deliveryId, signal, resolve, reject }));
            window.__pendingDeliveryDetails = () => pendingDetails.map(request => ({ workspaceId: request.workspaceId, aborted: request.signal.aborted }));
            window.__rejectNextDeliveryDetail = message => pendingDetails.shift()?.reject(new Error(message));
            const model = {
              authorization: { can: capability => capabilities.has(capability) },
              authorizationTargetWorkspaceId: "ws_authorized",
              workspaceRows: [
                { workspaceId: "ws_authorized", enterpriseName: "已授权客户", status: "active" },
                { workspaceId: "ws_other", enterpriseName: "其他客户", status: "active" },
              ],
              workspaceDirectoryLoading: false,
              loadWorkspaceDirectory: async () => undefined,
              setAuthorizationTargetWorkspaceId: workspaceId => { model.authorizationTargetWorkspaceId = workspaceId; render(); },
            };
            const root = createRoot(document.getElementById("root"));
            const render = () => root.render(React.createElement(App, null, React.createElement(CustomerDeliveryPage, { model })));
            window.__revokeWorkspaceDirectory = () => { capabilities.delete("workspace.directory.read"); render(); };
            window.__revokeCustomerDeliveryRead = () => { capabilities.delete("customer.delivery.read"); render(); };
            window.__revokeCustomerDeliveryUpdate = () => { capabilities.delete("customer.delivery.update"); render(); };
            window.__switchDeliveryWorkspace = workspaceId => { model.authorizationTargetWorkspaceId = workspaceId; render(); };
            render();
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__customer-delivery-revocation-test") return next();
            const html = `<!doctype html><html><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Customer delivery revocation test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("keeps records readable but removes every mutation entry when update permission is revoked", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-readonly", companyName: "只读客户", revision: 1 }]));
      await expect(page.getByText("只读客户", { exact: true }).isVisible()).resolves.toBe(true);

      await page.evaluate(() => window.__revokeCustomerDeliveryUpdate());

      await expect(page.getByText("当前为只读模式", { exact: true }).isVisible()).resolves.toBe(true);
      await expect(page.getByText("只读客户", { exact: true }).isVisible()).resolves.toBe(true);
      await expect(page.getByRole("button", { name: "查看交付详情", exact: true }).isEnabled()).resolves.toBe(true);
      await expect(page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).resolves.toBe(true);
      await expect(page.getByRole("button", { name: "保存清单", exact: true }).isDisabled()).resolves.toBe(true);
      await expect(page.getByTestId("delivery-section").getAttribute("data-read-only")).resolves.toBe("true");
      await expect(page.getByTestId("delivery-section").getAttribute("data-has-upload")).resolves.toBe("false");
    } finally { await page.close(); }
  }, 45_000);

  it("clears records and disables writes when workspace directory permission is revoked", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-visible", companyName: "撤权前客户" }]));
      await expect(page.getByText("撤权前客户", { exact: true }).isVisible()).resolves.toBe(true);

      await page.evaluate(() => window.__revokeWorkspaceDirectory());

      await expect(page.getByText("当前会话不能读取企业工作区目录", { exact: true }).isVisible()).resolves.toBe(true);
      await expect(page.getByText("撤权前客户", { exact: true }).count()).resolves.toBe(0);
      await expect(page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).resolves.toBe(true);
    } finally { await page.close(); }
  }, 45_000);

  it("rejects a late list response after workspace directory permission is revoked", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);

      await page.evaluate(() => window.__revokeWorkspaceDirectory());
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests()[0]?.aborted)).toBe(true);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-late", companyName: "迟到响应客户" }]));

      await expect(page.getByText("迟到响应客户", { exact: true }).count()).resolves.toBe(0);
      await expect(page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).resolves.toBe(true);
    } finally { await page.close(); }
  }, 45_000);

  it("does not read the old workspace when checklist authorization is revoked after a successful write", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-visible", companyName: "撤权前客户", revision: 1 }]));
      await page.getByRole("button", { name: "保存清单", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__pendingChecklistUpdates())).toEqual([{ workspaceId: "ws_authorized" }]);

      await page.evaluate(() => window.__revokeWorkspaceDirectory());
      await expect.poll(() => page.getByText("当前会话不能读取企业工作区目录", { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(() => window.__resolveNextChecklistUpdate());

      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__pendingDeliveryRequests())).toEqual([]);
      expect(await page.evaluate(() => window.__pendingDeliveryDetails())).toEqual([]);
      await expect(page.getByText("客户交付保存被阻断", { exact: true }).count()).resolves.toBe(0);
    } finally { await page.close(); }
  }, 45_000);

  it("does not reconcile checklist data after customer delivery read permission is revoked", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-visible", companyName: "读权限撤销前客户", revision: 1 }]));
      await page.getByRole("button", { name: "保存清单", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__pendingChecklistUpdates())).toEqual([{ workspaceId: "ws_authorized" }]);

      await page.evaluate(() => window.__revokeCustomerDeliveryRead());
      await expect.poll(() => page.getByText("当前会话没有客户交付读取权限", { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(() => window.__resolveNextChecklistUpdate());

      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__pendingDeliveryRequests())).toEqual([]);
      expect(await page.evaluate(() => window.__pendingDeliveryDetails())).toEqual([]);
      await expect(page.getByText("当前会话没有客户交付读取权限", { exact: true }).isVisible()).resolves.toBe(true);
      await expect(page.getByText("读权限撤销前客户", { exact: true }).count()).resolves.toBe(0);
      await expect(page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).resolves.toBe(true);
    } finally { await page.close(); }
  }, 45_000);

  it("does not read or overwrite the new workspace when checklist target changes after the write starts", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-old", companyName: "原工作区客户", revision: 1 }]));
      await page.getByRole("button", { name: "保存清单", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__pendingChecklistUpdates().length)).toBe(1);

      await page.evaluate(() => window.__switchDeliveryWorkspace("ws_other"));
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().map(request => request.workspaceId))).toEqual(["ws_other"]);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-new", companyName: "新工作区客户", revision: 1 }]));
      await page.evaluate(() => window.__resolveNextChecklistUpdate());

      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__pendingDeliveryRequests())).toEqual([]);
      expect(await page.evaluate(() => window.__pendingDeliveryDetails())).toEqual([]);
      await expect(page.getByText("新工作区客户", { exact: true }).isVisible()).resolves.toBe(true);
      await expect(page.getByText("原工作区客户", { exact: true }).count()).resolves.toBe(0);
    } finally { await page.close(); }
  }, 45_000);

  it("reports post-save reconciliation failure without misreporting the checklist write as failed", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__customer-delivery-revocation-test`);
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryRequests().length)).toBe(1);
      await page.evaluate(() => window.__resolveNextDeliveryRequest([{ id: "delivery-visible", companyName: "当前客户", revision: 1 }]));
      await page.getByRole("button", { name: "保存清单", exact: true }).click();
      await page.evaluate(() => window.__resolveNextChecklistUpdate(2));
      await expect.poll(() => page.evaluate(() => window.__pendingDeliveryDetails())).toEqual([{ workspaceId: "ws_authorized", aborted: false }]);

      await page.evaluate(() => window.__rejectNextDeliveryDetail("读取超时"));

      await expect.poll(() => page.getByText("保存成功", { exact: true }).isVisible()).toBe(true);
      await expect(page.getByText("客户交付保存被阻断", { exact: true }).count()).resolves.toBe(0);
      await expect.poll(() => page.getByText(/清单已保存，但最新档案读取失败/u).isVisible()).toBe(true);
    } finally { await page.close(); }
  }, 45_000);
});

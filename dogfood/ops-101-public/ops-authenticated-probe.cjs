const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const repoRoot = path.resolve(root, "../..");
const seed = fs.readFileSync(path.join(repoRoot, "infra/local/seed-demo.sql"), "utf8");
const accountMatch = seed.match(/Password:\s*([^\n]+)[\s\S]*?external_subject, display_name\)\s*VALUES\s*\([\s\S]*?'damai-password',\s*'([^']+)'/);
if (!accountMatch) throw new Error("platform QA credential fixture not found");
const password = accountMatch[1].trim();
const username = accountMatch[2].trim();
const screenshotRoot = path.join(root, "screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });

function wireEvidence(page, bucket) {
  page.on("console", (message) => bucket.consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => bucket.consoleMessages.push({ type: "pageerror", text: error.message }));
  page.on("requestfailed", (request) => bucket.failures.push({
    url: request.url(),
    resourceType: request.resourceType(),
    error: request.failure()?.errorText,
  }));
  page.on("response", (response) => {
    const request = response.request();
    if (["document", "stylesheet", "script", "xhr", "fetch"].includes(request.resourceType())) {
      bucket.responses.push({ status: response.status(), resourceType: request.resourceType(), url: response.url(), contentType: response.headers()["content-type"] || "" });
    }
  });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const normalize = (text) => (text || "").trim().replace(/\s+/g, " ");
    const headers = Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]")).map((node) => normalize(node.textContent));
    return {
      title: document.title,
      url: location.href,
      bodyText: document.body?.innerText || "",
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      headers,
      links: Array.from(document.querySelectorAll("a")).map((node) => ({ text: normalize(node.innerText || node.getAttribute("aria-label")), href: node.href })),
      buttons: Array.from(document.querySelectorAll("button")).map((node) => normalize(node.innerText || node.getAttribute("aria-label"))),
      menuItems: Array.from(document.querySelectorAll('[role="menuitem"], nav a, aside a')).map((node) => ({ text: normalize(node.textContent), href: node.href || null, expanded: node.getAttribute("aria-expanded") })),
      visibleTextCount: normalize(document.body?.innerText).length,
      accountNameCounts: ["Store Nova运营中心", "平台运营账号", "平台运营"].map((label) => ({ label, count: (document.body?.innerText.match(new RegExp(label, "g")) || []).length })),
      styles: Array.from(document.styleSheets).map((sheet) => ({ href: sheet.href, disabled: sheet.disabled })),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  const page = await context.newPage();
  const evidence = { consoleMessages: [], failures: [], responses: [], login: {}, pages: [] };
  wireEvidence(page, evidence);
  await page.goto("https://ops.yxsona.com/ops/users", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);
  const userInput = page.locator('input:not([type="password"])').first();
  const passwordInput = page.locator('input[type="password"]').first();
  if (!(await userInput.isVisible().catch(() => false)) || !(await passwordInput.isVisible().catch(() => false))) {
    evidence.login = { attempted: false, reason: "login form not visible", snapshot: await snapshot(page) };
  } else {
    await userInput.fill(username);
    await passwordInput.fill(password);
    const loginResponsePromise = page.waitForResponse((response) => response.url().includes("/auth/login"), { timeout: 30000 }).catch(() => null);
    await page.getByRole("button", { name: /登录平台运营后台/ }).click();
    const loginResponse = await loginResponsePromise;
    await page.waitForTimeout(7000);
    evidence.login = { attempted: true, status: loginResponse?.status() ?? null, resultingUrl: page.url(), snapshot: await snapshot(page) };
    if ((loginResponse?.status() ?? 500) >= 400) {
      await userInput.fill("");
      await passwordInput.fill("");
    }
  }
  for (const [name, url] of [["ops-users", "https://ops.yxsona.com/ops/users"], ["ops-finance", "https://ops.yxsona.com/ops/finance"]]) {
    if (page.url() !== url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(8000);
    const pageSnapshot = await snapshot(page);
    await page.screenshot({ path: path.join(screenshotRoot, `${name}-authenticated-1440x1000.png`) });
    await page.screenshot({ path: path.join(screenshotRoot, `${name}-authenticated-full.png`), fullPage: true });
    evidence.pages.push({ name, url, snapshot: pageSnapshot });
  }
  fs.writeFileSync(path.join(root, "ops-authenticated-observations.json"), JSON.stringify(evidence, null, 2));
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((error) => {
  fs.writeFileSync(path.join(root, "ops-authenticated-error.txt"), String(error?.stack || error));
  process.exit(1);
});

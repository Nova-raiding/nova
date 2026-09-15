const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const repoRoot = path.resolve(root, "../..");
const authHelper = fs.readFileSync(path.join(repoRoot, "dogfood/chatgpt-all-functions/merchant-auth.js"), "utf8");
const account = authHelper.match(/MERCHANT_E2E_LOGIN\s*\?\?\s*'([^']+)'/)?.[1];
const password = authHelper.match(/MERCHANT_E2E_PASSWORD\s*\?\?\s*'([^']+)'/)?.[1];
if (!account || !password) throw new Error("merchant QA credential fixture not found");

const screenshotRoot = path.join(root, "screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });

function evidenceFor(page) {
  const evidence = { consoleMessages: [], failures: [], responses: [] };
  page.on("console", (message) => evidence.consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => evidence.consoleMessages.push({ type: "pageerror", text: error.message }));
  page.on("requestfailed", (request) => evidence.failures.push({ url: request.url(), resourceType: request.resourceType(), error: request.failure()?.errorText }));
  page.on("response", (response) => {
    const request = response.request();
    if (["document", "stylesheet", "script", "xhr", "fetch"].includes(request.resourceType())) evidence.responses.push({ status: response.status(), resourceType: request.resourceType(), url: response.url(), contentType: response.headers()["content-type"] || "" });
  });
  return evidence;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const normalize = (text) => (text || "").trim().replace(/\s+/g, " ");
    return {
      title: document.title,
      url: location.href,
      bodyText: document.body?.innerText || "",
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      headers: Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]")).map((node) => normalize(node.textContent)),
      links: Array.from(document.querySelectorAll("a")).map((node) => ({ text: normalize(node.innerText || node.getAttribute("aria-label")), href: node.href })),
      buttons: Array.from(document.querySelectorAll("button")).map((node) => ({ text: normalize(node.innerText || node.getAttribute("aria-label")), expanded: node.getAttribute("aria-expanded") })),
      navText: Array.from(document.querySelectorAll("nav,aside")).map((node) => normalize(node.textContent)).filter(Boolean),
      styles: Array.from(document.styleSheets).map((sheet) => ({ href: sheet.href, disabled: sheet.disabled })),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  const page = await context.newPage();
  const evidence = evidenceFor(page);
  await page.goto("https://yxsona.com/merchant/login/merchant/overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  const accountInput = page.locator("#merchant-login-account");
  if (!(await accountInput.isVisible().catch(() => false))) {
    evidence.login = { attempted: false, reason: "login form not visible", snapshot: await snapshot(page) };
  } else {
    await accountInput.fill(account);
    await page.locator("#merchant-login-password").fill(password);
    const responsePromise = page.waitForResponse((response) => response.url().includes("/auth/login"), { timeout: 30000 }).catch(() => null);
    await page.getByRole("button", { name: "登录商家工作台", exact: true }).click();
    const response = await responsePromise;
    await page.waitForTimeout(10000);
    evidence.login = { attempted: true, status: response?.status() ?? null, snapshot: await snapshot(page) };
  }
  await page.screenshot({ path: path.join(screenshotRoot, "merchant-overview-authenticated-1440x1000.png") });
  await page.screenshot({ path: path.join(screenshotRoot, "merchant-overview-authenticated-full.png"), fullPage: true });
  fs.writeFileSync(path.join(root, "merchant-authenticated-observations.json"), JSON.stringify(evidence, null, 2));
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((error) => {
  fs.writeFileSync(path.join(root, "merchant-authenticated-error.txt"), String(error?.stack || error));
  process.exit(1);
});

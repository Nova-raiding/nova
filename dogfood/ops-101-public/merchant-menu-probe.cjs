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

async function menuState(page) {
  return page.evaluate(() => ({
    bodyText: document.body.innerText,
    buttons: Array.from(document.querySelectorAll("button")).map((node) => ({
      text: (node.innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "),
      expanded: node.getAttribute("aria-expanded"),
      visible: Boolean(node.getClientRects().length),
    })),
    links: Array.from(document.querySelectorAll("a")).map((node) => ({
      text: (node.innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "),
      href: node.href,
      visible: Boolean(node.getClientRects().length),
    })),
  }));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  const page = await context.newPage();
  const consoleMessages = [];
  const failures = [];
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: error.message }));
  page.on("requestfailed", (request) => failures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.goto("https://yxsona.com/merchant/login/merchant/overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#merchant-login-account").fill(account);
  await page.locator("#merchant-login-password").fill(password);
  await page.getByRole("button", { name: "登录商家工作台", exact: true }).click();
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30000 });
  const knowledgeButton = page.getByRole("button", { name: "知识库", exact: true });
  const before = await menuState(page);
  await knowledgeButton.click();
  await page.waitForTimeout(1000);
  const expanded = await menuState(page);
  await page.screenshot({ path: path.join(screenshotRoot, "merchant-knowledge-expanded-1440x1000.png") });
  await knowledgeButton.click();
  await page.waitForTimeout(1000);
  const collapsed = await menuState(page);
  await page.screenshot({ path: path.join(screenshotRoot, "merchant-knowledge-collapsed-1440x1000.png") });
  fs.writeFileSync(path.join(root, "merchant-menu-observations.json"), JSON.stringify({ before, expanded, collapsed, consoleMessages, failures }, null, 2));
  await browser.close();
  process.exit(0);
})().catch((error) => {
  fs.writeFileSync(path.join(root, "merchant-menu-error.txt"), String(error?.stack || error));
  process.exit(1);
});

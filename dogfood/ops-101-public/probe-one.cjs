const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const name = process.argv[2];
const url = process.argv[3];
const navigationTimeout = Number(process.env.QA_NAVIGATION_TIMEOUT_MS || 20000);
if (!name || !url) throw new Error("usage: probe-one <name> <url>");
const root = path.resolve(__dirname);
fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  const page = await context.newPage();
  const consoleMessages = [];
  const failures = [];
  const responses = [];
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: error.message }));
  page.on("requestfailed", (request) => failures.push({ url: request.url(), resourceType: request.resourceType(), error: request.failure()?.errorText }));
  page.on("response", (response) => {
    const request = response.request();
    if (["stylesheet", "script", "xhr", "fetch", "document"].includes(request.resourceType())) {
      responses.push({ status: response.status(), resourceType: request.resourceType(), url: response.url(), contentType: response.headers()["content-type"] || "" });
    }
  });
  let navigationStatus = null;
  let navigationError = null;
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
    navigationStatus = response?.status() ?? null;
    await page.waitForTimeout(3500);
  } catch (error) {
    navigationError = error.message;
  }
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyText: document.body?.innerText || "",
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    styleSheets: Array.from(document.styleSheets).map((sheet) => ({ href: sheet.href, disabled: sheet.disabled })),
    links: Array.from(document.querySelectorAll("a")).map((node) => ({ text: (node.innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "), href: node.href })),
    buttons: Array.from(document.querySelectorAll("button")).map((node) => (node.innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ")),
    inputs: Array.from(document.querySelectorAll("input")).map((node) => ({ type: node.type, name: node.name, label: node.getAttribute("aria-label"), placeholder: node.placeholder })),
  }));
  await page.screenshot({ path: path.join(root, "screenshots", `${name}-unauthenticated-1440x1000.png`) });
  fs.writeFileSync(path.join(root, `${name}-unauthenticated.json`), JSON.stringify({ name, url, navigationStatus, navigationError, consoleMessages, failures, responses, snapshot }, null, 2));
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((error) => {
  fs.writeFileSync(path.join(root, `${name}-probe-error.txt`), String(error?.stack || error));
  process.exit(1);
});

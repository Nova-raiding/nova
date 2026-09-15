const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const outputRoot = path.resolve(__dirname);
const screenshotRoot = path.join(outputRoot, "screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });

const targets = [
  ["merchant-overview", "https://yxsona.com/merchant/login/merchant/overview"],
  ["ops-users", "https://ops.yxsona.com/ops/users"],
  ["ops-finance", "https://ops.yxsona.com/ops/finance"],
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const [name, url] of targets) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      locale: "zh-CN",
    });
    const page = await context.newPage();
    const consoleMessages = [];
    const failures = [];
    const responses = [];
    page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: error.message }));
    page.on("requestfailed", (request) => failures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText,
    }));
    page.on("response", (response) => {
      const request = response.request();
      if (["stylesheet", "script", "xhr", "fetch", "document"].includes(request.resourceType())) {
        responses.push({
          status: response.status(),
          resourceType: request.resourceType(),
          url: response.url(),
          contentType: response.headers()["content-type"] || "",
        });
      }
    });
    let navigationStatus = null;
    let navigationError = null;
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      navigationStatus = response?.status() ?? null;
      await page.waitForTimeout(5000);
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
      links: Array.from(document.querySelectorAll("a")).map((node) => ({
        text: (node.innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "),
        href: node.href,
      })),
      buttons: Array.from(document.querySelectorAll("button")).map((node) =>
        (node.innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "),
      ),
      inputs: Array.from(document.querySelectorAll("input")).map((node) => ({
        type: node.type,
        name: node.name,
        label: node.getAttribute("aria-label"),
        placeholder: node.placeholder,
      })),
    }));
    await page.screenshot({ path: path.join(screenshotRoot, `${name}-unauthenticated.png`), fullPage: true });
    results.push({ name, url, navigationStatus, navigationError, consoleMessages, failures, responses, snapshot });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(outputRoot, "unauthenticated-observations.json"), JSON.stringify(results, null, 2));
})();

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { opsTheme } from "./theme/opsTheme.js"

describe("Ops Console root providers", () => {
  it("keeps the Ant Design app context inside the configured theme", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
    expect(source).toContain('import { App as AntdApp, ConfigProvider } from "antd"')
    expect(source).toContain("<ConfigProvider theme={opsTheme}>")
    expect(source).toContain("<AntdApp>")
    expect(source).toContain("purgeLocalOpsCredentialsForManagedSession(localStorage)")
    expect(source).toContain("purgeLocalOpsCredentialsForManagedSession(sessionStorage)")
    expect(source).toContain("</AntdApp>")
  })

  it("keeps desktop form controls at the accessible interaction size", () => {
    expect(opsTheme.components?.Button).toMatchObject({ controlHeight: 44, controlHeightSM: 36 })
    expect(opsTheme.components?.Input).toMatchObject({ controlHeight: 44 })
  })

  it("defines a visible, token-driven keyboard focus contract for desktop controls", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./styles.css", import.meta.url), "utf8"))
    expect(source).toContain("--ops-focus-color: #1d4ed8")
    expect(source).toContain(":where(.ant-btn, .ant-input")
    expect(source).toContain("outline: var(--ops-focus-width) solid var(--ops-focus-color)")
    expect(source).toContain("scroll-margin-block: 24px")
    expect(source).toContain("prefers-reduced-motion: reduce")
  })
})

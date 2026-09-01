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
})

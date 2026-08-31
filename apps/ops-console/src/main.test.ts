import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Ops Console root providers", () => {
  it("keeps the Ant Design app context inside the configured theme", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
    expect(source).toContain('import { App as AntdApp, ConfigProvider } from "antd"')
    expect(source).toContain("<ConfigProvider theme={opsTheme}>")
    expect(source).toContain("<AntdApp>")
    expect(source).toContain("</AntdApp>")
  })
})

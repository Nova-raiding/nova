import { readFileSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = new URL("../apps/ops-console/src/", import.meta.url);

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    return entry.isDirectory()
      ? sourceFiles(child)
      : extname(entry.name) === ".tsx" || extname(entry.name) === ".ts"
        ? [child]
        : [];
  });
}

describe("ops console component architecture", () => {
  it("keeps the controller focused on composition instead of page markup", () => {
    const controller = readFileSync(
      new URL("pages/OpsConsoleController.tsx", srcRoot),
      "utf8",
    );
    expect(controller).not.toContain("营销能力运营治理");
    expect(controller).not.toContain("套餐、加购与增长规则");
    expect(controller).not.toMatch(/from ["'][^"']*\/\w+Page(?:\.js)?["']/u);
    expect(controller).not.toMatch(/\b(?:Card|Table|Form|Descriptions)\b/u);
    expect(controller).not.toMatch(/\b(?:rpc|opsRestGet|rpcWithMeta)\s*\(/u);
    expect(controller).toContain("const ActivePage = opsPageRegistry[activeDomain]");
    expect(controller).toContain("<ActivePage model={model}");
    expect(controller).toContain("<OpsPageBoundary resetKey={activeDomain}>");
  });

  it("uses real domain pages instead of generic children wrappers", () => {
    for (const pageName of [
      "OverviewPage.tsx",
      "UsersPage.tsx",
      "TasksPage.tsx",
      "StoresPage.tsx",
      "FinancePage.tsx",
    ]) {
      const page = readFileSync(new URL(`pages/${pageName}`, srcRoot), "utf8");
      expect(page, pageName).not.toContain("children: ReactNode");
      expect(page.split("\n").length, pageName).toBeGreaterThan(18);
      expect(page.split("\n").length, pageName).toBeLessThan(120);
    }
  });

  it("loads domain pages through a route registry instead of one page bundle", () => {
    const registry = readFileSync(
      new URL("navigation/opsPageRegistry.tsx", srcRoot),
      "utf8",
    );
    for (const pageName of [
      "OverviewPage",
      "TasksPage",
      "StoresPage",
      "RulesPage",
      "ModelsPage",
      "FinancePage",
      "AuditPage",
    ]) {
      expect(registry).toContain(`import(\"../pages/${pageName}.js\")`);
    }
    expect(registry).toContain('import { UsersPage } from "../pages/UsersPage.js"');
    expect(registry).toContain("users: lazy(async () => ({ default: UsersPage }))");
    for (const routeName of ["SupportRoute", "IncidentsRoute", "FeatureFlagsRoute"]) {
      expect(registry).toContain(`import("./routes/${routeName}.js")`);
    }
    expect(registry).toContain('storage: lazy(');
    expect(registry.match(/lazy\(/gu)).toHaveLength(13);
  });

  it("separates transport and domain types from React page files", () => {
    const relativeFiles = sourceFiles(srcRoot).map((file) =>
      file.pathname.slice(srcRoot.pathname.length),
    );
    expect(
      relativeFiles.some((file) =>
        /(?:api|client|transport)\.(?:ts|tsx)$/u.test(basename(file)),
      ),
    ).toBe(true);
    expect(
      relativeFiles.some((file) =>
        /(?:types|model)\.(?:ts|tsx)$/u.test(basename(file)),
      ),
    ).toBe(true);
  });
});

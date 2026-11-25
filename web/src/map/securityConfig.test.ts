import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAmapProxy, resolveAmapServiceHost } from "./securityConfig";

afterEach(() => vi.unstubAllGlobals());
describe("same-origin AMap proxy", () => {
  it("resolves a relative proxy and removes the legacy clear-text setting", () => {
    const w = { location: { origin: "https://demo.example" }, _AMapSecurityConfig: { securityJsCode: "old-test-value" } };
    vi.stubGlobal("window", w);
    configureAmapProxy("/_AMapService");
    expect(w._AMapSecurityConfig).toEqual({ serviceHost: "https://demo.example/_AMapService" });
  });
  it.each(["https://evil.example/_AMapService", "//evil.example/_AMapService", "/api", "/_AMapService?jscode=x", "/_AMapService#x"])("rejects unsupported proxy %s", (url) => {
    expect(() => resolveAmapServiceHost(url, "https://demo.example")).toThrow("代理配置无效");
  });
  it("defaults to same origin", () => {
    expect(resolveAmapServiceHost(undefined, "https://demo.example")).toBe("https://demo.example/_AMapService");
  });
});

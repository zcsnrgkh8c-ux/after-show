import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@amap/amap-jsapi-loader", () => ({
  default: { load: vi.fn() },
}));

import AMapLoader from "@amap/amap-jsapi-loader";
import { __resetAmapLoaderForTest, loadAmap } from "./amapLoader";
import type { AMapNamespace, LoadError } from "./types";

const loadMock = vi.mocked(AMapLoader.load);
const fakeNs = {} as AMapNamespace;

async function captureLoadError(): Promise<LoadError> {
  try {
    await loadAmap({ timeout_ms: 100 });
  } catch (error) {
    return error as LoadError;
  }
  throw new Error("expected loadAmap to reject");
}

beforeEach(() => {
  __resetAmapLoaderForTest();
  loadMock.mockReset();
  vi.stubEnv("VITE_AMAP_KEY", "public-key-sentinel");
  vi.stubGlobal("window", { location: { origin: "https://demo.example" } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("travel amapLoader：第三方错误不回显凭据", () => {
  it("异步拒绝使用固定安全文案，并在失败后允许重试", async () => {
    loadMock.mockRejectedValueOnce(
      new Error("invalid key public-key-sentinel / leaked-security-sentinel"),
    );

    const error = await captureLoadError();
    expect(error.code).toBe("dynamic_import_failed");
    expect(error.message).toContain("高德 JSAPI 加载失败");
    expect(error.message).not.toContain("public-key-sentinel");
    expect(error.message).not.toContain("leaked-security-sentinel");

    loadMock.mockResolvedValueOnce(fakeNs as never);
    expect(await loadAmap({ timeout_ms: 100 })).toBe(fakeNs);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("同步抛错同样不回显凭据", async () => {
    loadMock.mockImplementationOnce(() => {
      throw new Error("sync failure public-key-sentinel");
    });

    const error = await captureLoadError();
    expect(error.code).toBe("dynamic_import_failed");
    expect(error.message).not.toContain("public-key-sentinel");
  });
});


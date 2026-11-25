import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AMAP_PLUGIN_TIMEOUT_MS,
  candidateResponseMatchesCurrent,
  candidateSelectionStillValid,
  canEnterNearbyDiscovery,
  createCitySearchPort,
  createGeolocationPort,
  createPlaceSearchPort,
  describeLocation,
  locateByGeolocation,
  locateByKeyword,
  locateWithFallback,
  nearbySearchEligibility,
  venueExitSearchEligibility,
  NEARBY_SEARCH_MAX_ACCURACY_M,
  parseCityBounds,
  rankPlaceCandidates,
  resetLocatePluginsForTest,
  type CitySearchPort,
  type GeolocationPort,
  type PlaceSearchPort,
} from "./locate";
import type { AmapNamespace } from "./types";

beforeEach(() => {
  resetLocatePluginsForTest();
});

describe("locateByGeolocation：浏览器精确定位", () => {
  it("定位成功：标记为 browser 精度并保留精度值", async () => {
    const port: GeolocationPort = {
      getCurrentPosition: async () => ({ position: [116.3, 39.9], accuracyM: 50 }),
    };
    const r = await locateByGeolocation(port);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.location.position).toEqual([116.3, 39.9]);
      expect(r.location.precision).toBe("browser");
      expect(r.location.label).toBe("当前定位");
      expect(r.location.accuracyM).toBe(50);
    }
  });

  it("定位失败：如实透传原因，不伪造位置", async () => {
    const denied: GeolocationPort = {
      getCurrentPosition: async () => {
        throw new Error("浏览器拒绝了定位授权：请在地址栏允许定位，或改用地点关键词跳转");
      },
    };
    const r = await locateByGeolocation(denied);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("授权");
  });
});

describe("locateWithFallback：浏览器失败 → IP 城市级降级", () => {
  const failGeo: GeolocationPort = {
    getCurrentPosition: async () => {
      throw new Error("浏览器定位超时");
    },
  };

  it("浏览器定位成功时不触发 IP 定位", async () => {
    const cityPort: CitySearchPort = { getLocalCity: vi.fn() };
    const r = await locateWithFallback(
      { getCurrentPosition: async () => ({ position: [116.3, 39.9] }) },
      cityPort
    );
    expect(r.ok).toBe(true);
    expect(cityPort.getLocalCity).not.toHaveBeenCalled();
  });

  it("浏览器失败 → 降级到城市级，并明确标注精度", async () => {
    const cityPort: CitySearchPort = {
      getLocalCity: async () => ({ city: "广州市", position: [113.26, 23.13] }),
    };
    const r = await locateWithFallback(failGeo, cityPort);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.location.precision).toBe("city");
      expect(r.location.label).toBe("广州市");
      expect(describeLocation(r.location)).toContain("城市级");
    }
  });

  it("浏览器与 IP 都失败：返回浏览器定位的原始原因，不掩盖", async () => {
    const cityPort: CitySearchPort = { getLocalCity: async () => null };
    const r = await locateWithFallback(failGeo, cityPort);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("浏览器定位超时");
  });

  it("第二层 IP 定位成功：跳过 CitySearch，标注城市级", async () => {
    const cityPort: CitySearchPort = { getLocalCity: vi.fn() };
    const ipPort: GeolocationPort = { getCurrentPosition: async () => ({ position: [113.3, 23.1] }) };
    const r = await locateWithFallback(failGeo, cityPort, ipPort);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.location.precision).toBe("city");
      expect(r.location.label).toContain("IP 定位");
      expect(r.location.position).toEqual([113.3, 23.1]);
    }
    expect(cityPort.getLocalCity).not.toHaveBeenCalled();
  });

  it("IP 层失败后继续走 CitySearch", async () => {
    const cityPort: CitySearchPort = {
      getLocalCity: async () => ({ city: "广州市", position: [113.26, 23.13] }),
    };
    const ipPort: GeolocationPort = {
      getCurrentPosition: async () => {
        throw new Error("IP 定位失败");
      },
    };
    const r = await locateWithFallback(failGeo, cityPort, ipPort);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.location.label).toBe("广州市");
  });

  it("IP 定位抛错不阻断降级失败结果", async () => {
    const cityPort: CitySearchPort = {
      getLocalCity: async () => {
        throw new Error("network");
      },
    };
    const r = await locateWithFallback(failGeo, cityPort);
    expect(r.ok).toBe(false);
  });
});

describe("locateByKeyword：手动输入跳转", () => {
  const port: PlaceSearchPort = {
    searchFirst: async (kw) => (kw === "不存在的地点xyz" ? null : { position: [113.2, 23.1], name: `${kw}（匹配结果）` }),
  };

  it("空白关键词：直接拒绝，不发搜索", async () => {
    const spy: PlaceSearchPort = { searchFirst: vi.fn() };
    const r = await locateByKeyword(spy, "   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("请输入");
    expect(spy.searchFirst).not.toHaveBeenCalled();
  });

  it("无命中：如实提示未找到", async () => {
    const r = await locateByKeyword(port, "不存在的地点xyz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("未找到");
  });

  it("命中：使用匹配地点名作为标签，精度为 manual", async () => {
    const r = await locateByKeyword(port, "体育馆");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.location.precision).toBe("manual");
      expect(r.location.label).toBe("体育馆（匹配结果）");
      expect(r.location.position).toEqual([113.2, 23.1]);
    }
  });
});

describe("主体场馆候选确认：不盲信首条 POI", () => {
  const query = "万达广场(南昌红谷滩店)";
  const position: [number, number] = [115.86, 28.68];

  it("首条停车场不得冒充主体，完整分店主体排到前面", () => {
    const ranked = rankPlaceCandidates(
      [
        { name: "万达广场红谷滩店地下停车场", position, query, branchTerms: ["南昌红谷滩店"], isPrincipal: false },
        { id: "wanda", name: "万达广场(南昌红谷滩店)", position, query, branchTerms: ["南昌红谷滩店"], isPrincipal: true },
      ],
      query
    );
    expect(ranked[0].id).toBe("wanda");
    expect(ranked[1].isPrincipal).toBe(false);
  });

  it("编辑输入后上一轮确认失效；乱序或旧查询响应均不接收", () => {
    expect(candidateSelectionStillValid(query, query)).toBe(true);
    expect(candidateSelectionStillValid(query, "万达广场(八一店)")).toBe(false);
    expect(candidateResponseMatchesCurrent(4, 5, query, query)).toBe(false);
    expect(candidateResponseMatchesCurrent(5, 5, query, "万达广场(八一店)")).toBe(false);
    expect(candidateResponseMatchesCurrent(5, 5, query, query)).toBe(true);
  });
});

describe("describeLocation：说明文案不夸大精度", () => {
  it("精确定位带精度", () => {
    expect(
      describeLocation({
        position: [0, 0],
        source: "geolocation",
        precision: "browser",
        label: "当前定位",
        accuracyM: 47.6,
      })
    ).toBe("已定位到当前位置（精度约 ±48m）");
  });
  it("城市级明确告知降级", () => {
    expect(
      describeLocation({ position: [0, 0], source: "geolocation", precision: "city", label: "广州市" })
    ).toContain("城市级定位：广州市");
  });
  it("手动输入无精度字段", () => {
    expect(
      describeLocation({ position: [0, 0], source: "manual", precision: "manual", label: "体育馆" })
    ).toBe("已跳转到：体育馆");
  });
});

describe("nearbySearchEligibility：粗定位不得直接检索附近出口", () => {
  it("城市级/IP 定位（实测 ±50 公里）拒绝，要求先确认具体地点", () => {
    const r = nearbySearchEligibility({
      position: [113.26, 23.13],
      source: "geolocation",
      precision: "city",
      label: "广州市",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("确认具体地点");
      expect(r.reason).toContain("粗定位");
    }
  });

  it("浏览器定位误差超过阈值（如 ±50 公里）拒绝", () => {
    const r = nearbySearchEligibility({
      position: [113.26, 23.13],
      source: "geolocation",
      precision: "browser",
      label: "当前定位",
      accuracyM: 50_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("50000");
  });

  it("浏览器定位精度未知时拒绝，不猜“够准”", () => {
    const r = nearbySearchEligibility({
      position: [113.26, 23.13],
      source: "geolocation",
      precision: "browser",
      label: "当前定位",
    });
    expect(r.ok).toBe(false);
  });

  it("浏览器定位在阈值内允许", () => {
    expect(
      nearbySearchEligibility({
        position: [113.26, 23.13],
        source: "geolocation",
        precision: "browser",
        label: "当前定位",
        accuracyM: NEARBY_SEARCH_MAX_ACCURACY_M,
      }).ok
    ).toBe(true);
  });

  it("手动输入/选择的具体地点视为已确认，允许检索", () => {
    expect(
      nearbySearchEligibility({
        position: [115.86, 28.65],
        source: "manual",
        precision: "manual",
        label: "南昌西站",
      }).ok
    ).toBe(true);
  });

  it("尚未定位时拒绝并给出前置动作", () => {
    const r = nearbySearchEligibility(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("定位");
  });

  it("手动输入被编辑后但未重新确认主体：按钮应直接禁用", () => {
    const r = venueExitSearchEligibility(
      { position: [115.86, 28.68], source: "manual", precision: "manual", label: "旧候选" },
      false
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("确认主体场馆");
    expect(
      venueExitSearchEligibility(
        { position: [115.86, 28.68], source: "manual", precision: "manual", label: "已确认候选" },
        true
      ).ok
    ).toBe(true);
  });
});

describe("canEnterNearbyDiscovery：自动定位不得清空默认场馆", () => {
  it("国内精确定位且视野可移动才允许切换附近发现模式", () => {
    const precise = {
      position: [115.87, 28.74] as [number, number],
      source: "geolocation" as const,
      precision: "browser" as const,
      label: "当前定位",
      accuracyM: 40,
    };
    expect(canEnterNearbyDiscovery(precise, true)).toBe(true);
    expect(canEnterNearbyDiscovery(precise, false)).toBe(false); // 境外/不可移动视野
  });

  it("±20km 粗定位和城市级定位均拒绝，保留当前场馆地图", () => {
    expect(
      canEnterNearbyDiscovery(
        {
          position: [115.87, 28.74],
          source: "geolocation",
          precision: "browser",
          label: "当前定位",
          accuracyM: 20_000,
        },
        true
      )
    ).toBe(false);
    expect(
      canEnterNearbyDiscovery(
        { position: [115.87, 28.74], source: "geolocation", precision: "city", label: "南昌市" },
        true
      )
    ).toBe(false);
  });
});

describe("AMap 插件适配（伪命名空间）", () => {
  function fakeAmap(behavior: "ok" | "denied" | "noPlugin"): AmapNamespace {
    if (behavior === "noPlugin") return {} as AmapNamespace;
    return {
      plugin: (_names: string[], cb: () => void) => cb(),
      Geolocation: class {
        getCurrentPosition(cb: (status: string, result: never) => void): void {
          if (behavior === "ok") {
            cb("complete", { position: { lng: 116.3, lat: 39.9 }, accuracy: 30 } as never);
          } else {
            cb("error", { info: "Get geolocation permission denied." } as never);
          }
        }
      },
      CitySearch: class {
        getLocalCity(cb: (status: string, result: never) => void): void {
          cb("complete", {
            city: "广州市",
            bounds: [
              [113.0, 22.9],
              [113.6, 23.4],
            ],
          } as never);
        }
      },
      PlaceSearch: class {
        search(_kw: string, cb: (status: string, result: never) => void): void {
          cb("complete", { poiList: { pois: [{ name: "测试场馆", location: { lng: 113.2, lat: 23.1 } }] } } as never);
        }
      },
    } as unknown as AmapNamespace;
  }

  it("定位插件：成功回调包装为 Promise，授权拒绝映射为可操作提示", async () => {
    const okPort = createGeolocationPort(fakeAmap("ok"));
    const r = await locateByGeolocation(okPort);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.location.accuracyM).toBe(30);

    const deniedPort = createGeolocationPort(fakeAmap("denied"));
    const r2 = await locateByGeolocation(deniedPort);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("授权");
  });

  it("CitySearch：取城市边界中点作为城市级位置", async () => {
    const port = createCitySearchPort(fakeAmap("ok"));
    const city = await port.getLocalCity();
    expect(city).not.toBeNull();
    expect(city!.city).toBe("广州市");
    expect(city!.position[0]).toBeCloseTo(113.3, 3);
    expect(city!.position[1]).toBeCloseTo(23.15, 3);
  });

  it("CitySearch：兼容高德实际返回的字符串 bounds 格式", async () => {
    const AMap = {
      plugin: (_n: string[], cb: () => void) => cb(),
      CitySearch: class {
        getLocalCity(cb: (s: string, r: never) => void): void {
          cb("complete", { city: "广州市", bounds: "113.0,22.9;113.6,23.4" } as never);
        }
      },
    } as unknown as AmapNamespace;
    const city = await createCitySearchPort(AMap).getLocalCity();
    expect(city).not.toBeNull();
    expect(city!.position[0]).toBeCloseTo(113.3, 3);
    expect(city!.position[1]).toBeCloseTo(23.15, 3);
  });

  it("parseCityBounds：非法输入返回 null，不猜坐标", () => {
    expect(parseCityBounds(undefined)).toBeNull();
    expect(parseCityBounds("abc")).toBeNull();
    expect(parseCityBounds([[113, 22], [0]])).toBeNull();
    expect(parseCityBounds("113.0,22.9;113.6,23.4")).toEqual({ sw: [113, 22.9], ne: [113.6, 23.4] });
  });

  it("搜索插件：命中返回坐标与名称", async () => {
    const port = createPlaceSearchPort(fakeAmap("ok"));
    const r = await locateByKeyword(port, "场馆");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.location.label).toBe("测试场馆");
  });

  it("搜索候选：保留 id/type/原查询/分店词，并标出附属停车场", async () => {
    const AMap = {
      plugin: (_names: string[], cb: () => void) => cb(),
      PlaceSearch: class {
        search(_kw: string, cb: (status: string, result: never) => void): void {
          cb("complete", {
            poiList: {
              pois: [
                {
                  id: "parking",
                  name: "万达广场红谷滩店地下停车场",
                  type: "交通设施服务;停车场",
                  address: "会展路",
                  location: { lng: 115.86, lat: 28.68 },
                },
                {
                  id: "wanda",
                  name: "万达广场(南昌红谷滩店)",
                  type: "购物服务;商场",
                  location: { lng: 115.861, lat: 28.681 },
                },
                {
                  id: "wanda-bayi",
                  name: "万达广场(八一店)",
                  type: "购物服务;商场",
                  location: { lng: 115.89, lat: 28.67 },
                },
              ],
            },
          } as never);
        }
      },
    } as unknown as AmapNamespace;
    const port = createPlaceSearchPort(AMap);
    const candidates = await port.searchCandidates!("万达广场(南昌红谷滩店)");
    expect(candidates[0]).toMatchObject({
      id: "parking",
      query: "万达广场(南昌红谷滩店)",
      branchTerms: ["南昌红谷滩店"],
      isPrincipal: false,
    });
    expect(candidates[1]).toMatchObject({ id: "wanda", type: "购物服务;商场", isPrincipal: true });
    // 用户虽然搜的是红谷滩店，但明确选择“八一店”候选后，身份必须跟候选而不是原查询。
    expect(candidates[2]).toMatchObject({ id: "wanda-bayi", branchTerms: ["八一店"] });
  });

  it("SDK 不支持插件加载：明确失败而非挂起", async () => {
    const port = createGeolocationPort(fakeAmap("noPlugin"));
    const r = await locateByGeolocation(port);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不支持插件加载");
  });

  it("插件只加载一次（缓存），多个端口复用", async () => {
    const pluginSpy = vi.fn((_names: string[], cb: () => void) => cb());
    const AMap = {
      plugin: pluginSpy,
      Geolocation: class {
        getCurrentPosition(cb: (s: string, r: never) => void): void {
          cb("complete", { position: { lng: 1, lat: 1 } } as never);
        }
      },
    } as unknown as AmapNamespace;
    await locateByGeolocation(createGeolocationPort(AMap));
    await locateByGeolocation(createGeolocationPort(AMap));
    expect(pluginSpy).toHaveBeenCalledTimes(1);
  });
});

describe("插件加载超时：不得让 UI 永久停在“定位中”", () => {
  it("plugin 回调不触发 → 超时拒绝并清缓存，重试可重新加载", async () => {
    vi.useFakeTimers();
    try {
      const neverCb = { plugin: vi.fn() } as unknown as AmapNamespace;
      const port = createGeolocationPort(neverCb);
      const guard = expect(port.getCurrentPosition()).rejects.toThrow(/插件加载超时/);
      await vi.advanceTimersByTimeAsync(AMAP_PLUGIN_TIMEOUT_MS + 10);
      await guard;

      // 缓存已清空：再次调用会重新请求插件（旧请求未回调也不复用）
      const retryAmap = {
        plugin: vi.fn((_n: string[], cb: () => void) => cb()),
        Geolocation: class {
          getCurrentPosition(cb: (s: string, r: never) => void): void {
            cb("complete", { position: { lng: 1, lat: 1 } } as never);
          }
        },
      } as unknown as AmapNamespace;
      const r = await createGeolocationPort(retryAmap).getCurrentPosition();
      expect(r.position).toEqual([1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

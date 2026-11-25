import { describe, expect, it } from "vitest";
import type { PlaceCandidate } from "./locate";
import {
  buildSelectedVenueLayout,
  findGatesForSelectedVenue,
  gateBelongsToSelectedVenue,
  type NearbyPoi,
  type NearbySearchPort,
} from "./venueGeometry";

const WANDA: PlaceCandidate = {
  id: "B0FFF-WANDA",
  name: "万达广场(南昌红谷滩店)",
  position: [115.858, 28.683],
  type: "购物服务;商场;购物中心",
  query: "万达广场(南昌红谷滩店)",
  branchTerms: ["南昌红谷滩店"],
  isPrincipal: true,
};

const poi = (name: string, position: [number, number] = [115.8582, 28.6831]): NearbyPoi => ({ name, position });

describe("所选场馆出口归属：万达不能吸收停车场、学校或其他分店", () => {
  it("完整主体+分店证据可接收；停车场门、南昌二中门和跨分店均拒绝", () => {
    expect(gateBelongsToSelectedVenue(WANDA, poi("万达广场(红谷滩店)1号门"))).toBe(true);
    expect(gateBelongsToSelectedVenue(WANDA, poi("万达广场红谷滩店地下停车场入口"))).toBe(false);
    expect(gateBelongsToSelectedVenue(WANDA, poi("南昌市第二中学东门"))).toBe(false);
    expect(gateBelongsToSelectedVenue(WANDA, poi("万达广场(八一店)1号门"))).toBe(false);
  });

  it("原查询为红谷滩、但确认八一店候选后，只接收八一店的门", () => {
    const confirmedBayi: PlaceCandidate = {
      ...WANDA,
      id: "B0FFF-BAYI",
      name: "万达广场(八一店)",
      // 原查询保留用于审计，但候选自身分店身份优先
      query: "万达广场(南昌红谷滩店)",
      branchTerms: ["八一店"],
    };
    expect(gateBelongsToSelectedVenue(confirmedBayi, poi("万达广场(八一店)1号门"))).toBe(true);
    expect(gateBelongsToSelectedVenue(confirmedBayi, poi("万达广场(红谷滩店)1号门"))).toBe(false);
  });

  it("父 POI id 是强归属证据，但附属停车场门仍不可作观众出口", () => {
    expect(
      gateBelongsToSelectedVenue(WANDA, {
        ...poi("红谷滩万达1号门"),
        parentPoiId: WANDA.id,
      })
    ).toBe(true);
    expect(
      gateBelongsToSelectedVenue(WANDA, {
        ...poi("地下停车场入口"),
        parentPoiId: WANDA.id,
      })
    ).toBe(false);
  });

  it("检索只返回停车场/学校门时如实无结果，不回退附近学校", async () => {
    const port: NearbySearchPort = {
      searchFirst: async () => null,
      searchNearby: async () => [poi("南昌市第二中学东门"), poi("万达广场地下停车场入口")],
      autocomplete: async () => [poi("南昌市第二中学北门"), poi("万达广场(八一店)1号门")],
    };
    const result = await findGatesForSelectedVenue(port, WANDA, 800, "南昌市");
    expect(result.venue.name).toBe(WANDA.name);
    expect(result.gates).toEqual([]);
  });
});

describe("所选场馆无可信出口：清空上一地点布局", () => {
  it("只保留当前主体 S，不保留旧 E/P，也不把接驳站单独挂上去", () => {
    const layout = buildSelectedVenueLayout(WANDA, [], [poi("卫东地铁站")]);
    expect(layout.geo.venueName).toBe(WANDA.name);
    expect(layout.geo.nodes).toEqual({ S: WANDA.position });
    expect(layout.notes.join("")).toContain("已清空上一地点");
    expect(layout.notes.join("")).toContain("不会用附近学校");
  });

  it("可信门和接驳点写入真实 POI 展示名，节点 ID 仍是 E/P 演示映射", () => {
    const layout = buildSelectedVenueLayout(
      WANDA,
      [poi("万达广场(红谷滩店)4号门"), poi("万达广场(红谷滩店)东门")],
      [poi("卫东地铁站")]
    );
    expect(layout.geo.nodeLabels).toEqual({
      S: WANDA.name,
      E1: "万达广场(红谷滩店)4号门",
      E2: "万达广场(红谷滩店)东门",
      P1: "卫东地铁站",
    });
    expect(layout.geo.nodes.E1).toBeDefined();
    expect(layout.geo.nodes.E3).toBeUndefined();
  });
});

/**
 * 高德地图展示配置（集中管理，凭据不入源码）：
 * - VITE_AMAP_KEY：公开 JS API key；amapServiceHost 指向同源代理，安全密钥仅存服务端；
 * - VITE_MAP_GEO_JSON：场地地理映射（见 .env.example）。
 *
 * 坐标约定：键为 node_id / edge_id；值为 [经度, 纬度]（高德 JS API 经纬度顺序），
 * 坐标系为 GCJ-02（火星坐标系），WGS-84 坐标须先自行转换。
 * 该映射仅用于展示，绝不进入计算模型；Scenario 的 0~100 示意坐标保持不变。
 */
import type { Scenario } from "../contract/types";
import { getRuntimeConfig, runtimeOrEnv } from "../runtimeConfig";

/** [经度, 纬度] */
export type LngLat = [number, number];

export interface GeoMapping {
  venueName: string;
  /** 坐标是否经确认；false 时界面常驻“坐标未经核实”提示 */
  coordVerified: boolean;
  /** 初始视野中心（缺省取场馆 S 节点） */
  center?: LngLat;
  /** node_id → [lng, lat] */
  nodes: Record<string, LngLat>;
  /** node_id → 真实 POI 展示名；仅覆盖地图文字，node_id/Scenario/仿真保持不变 */
  nodeLabels?: Record<string, string>;
  /** edge_id → 折线点串（可选；缺省时按两端节点直连，并标注“模拟通道示意”） */
  edges?: Record<string, LngLat[]>;
}

export type MapConfigState =
  | { ok: true; key: string; serviceHost: string; geo: GeoMapping }
  | { ok: false; missing: string[]; issues: string[] };

function parseLngLat(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lng, lat] = v as unknown[];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return [lng, lat];
}

/** 纯解析：从 JSON 字符串解析地理映射并按当前场景校验节点覆盖度（可单测） */
export function parseGeoMapping(
  json: string | undefined,
  scenario: Scenario
): { geo: GeoMapping | null; issues: string[] } {
  const issues: string[] = [];
  if (!json || json.trim() === "") {
    return { geo: null, issues: ["未配置 VITE_MAP_GEO_JSON（场地坐标映射）"] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { geo: null, issues: ["VITE_MAP_GEO_JSON 不是合法 JSON"] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { geo: null, issues: ["VITE_MAP_GEO_JSON 顶层应为对象"] };
  }
  const o = raw as Record<string, unknown>;

  const nodes: Record<string, LngLat> = {};
  const nodesRaw = (o.nodes ?? {}) as Record<string, unknown>;
  if (typeof nodesRaw === "object" && nodesRaw !== null) {
    for (const [k, v] of Object.entries(nodesRaw)) {
      const p = parseLngLat(v);
      if (p) nodes[k] = p;
      else issues.push(`节点 ${k} 坐标非法（应为 [经度,纬度]，|lng|≤180 且 |lat|≤90），已忽略`);
    }
  }
  const missingNodes = scenario.nodes.filter((n) => !nodes[n.node_id]).map((n) => n.node_id);
  if (missingNodes.length > 0) issues.push(`缺少节点坐标：${missingNodes.join("、")}`);

  const edges: Record<string, LngLat[]> = {};
  if (o.edges && typeof o.edges === "object" && !Array.isArray(o.edges)) {
    for (const [k, v] of Object.entries(o.edges as Record<string, unknown>)) {
      if (!Array.isArray(v)) {
        issues.push(`通道 ${k} 折线应为坐标数组，已忽略`);
        continue;
      }
      const pts = v.map(parseLngLat);
      if (pts.some((p) => p === null)) issues.push(`通道 ${k} 折线含非法坐标，已忽略`);
      else if (pts.length >= 2) edges[k] = pts as LngLat[];
    }
  }

  const center = o.center !== undefined ? parseLngLat(o.center) ?? undefined : undefined;
  if (o.center !== undefined && !center) issues.push("center 坐标非法，已忽略");

  const nodeLabels: Record<string, string> = {};
  if (o.nodeLabels && typeof o.nodeLabels === "object" && !Array.isArray(o.nodeLabels)) {
    for (const [k, v] of Object.entries(o.nodeLabels as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() !== "") nodeLabels[k] = v.trim();
      else issues.push(`节点 ${k} 展示名应为非空字符串，已忽略`);
    }
  }

  const geo: GeoMapping = {
    venueName: typeof o.venueName === "string" && o.venueName.trim() !== "" ? o.venueName.trim() : "（未命名场地）",
    coordVerified: o.coordVerified === true,
    center,
    nodes,
    nodeLabels,
    edges,
  };
  return { geo, issues };
}

/** 汇总公开地图配置；安全密钥由同源网关管理。 */
export function getMapConfig(scenario: Scenario): MapConfigState {
  // 运行时配置（/demo-config.js）优先，未配置时回退构建期环境变量。
  const runtime = getRuntimeConfig();
  const key = runtimeOrEnv(runtime.amapKey, import.meta.env.VITE_AMAP_KEY as string | undefined);
  const serviceHost = runtime.amapServiceHost || "/_AMapService";
  const { geo, issues } = parseGeoMapping(
    runtimeOrEnv(runtime.mapGeoJson, import.meta.env.VITE_MAP_GEO_JSON as string | undefined),
    scenario
  );

  const missing: string[] = [];
  if (key === "") missing.push("VITE_AMAP_KEY");
  const nodesCovered = geo !== null && scenario.nodes.every((n) => geo.nodes[n.node_id] !== undefined);
  if (!nodesCovered) missing.push("场地坐标（VITE_MAP_GEO_JSON）");

  if (missing.length > 0 || !geo) return { ok: false, missing, issues };
  return { ok: true, key, serviceHost, geo };
}

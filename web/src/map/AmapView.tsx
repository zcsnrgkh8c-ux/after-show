import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Plan, Scenario, ScenarioNode, SimulationResult, TimelineFrame } from "../contract/types";
import { getMapConfig, type GeoMapping } from "./config";
import { loadAmap } from "./amapLoader";
import {
  createCitySearchPort,
  createGeolocationPort,
  createIpGeolocationPort,
  createPlaceSearchPort,
  candidateResponseMatchesCurrent,
  candidateSelectionStillValid,
  canEnterNearbyDiscovery,
  describeLocation,
  getGeolocationPermission,
  locateWithFallback,
  nearbySearchEligibility,
  venueExitSearchEligibility,
  searchPlaceCandidates,
  type PlaceCandidate,
  type UserLocation,
} from "./locate";
import {
  buildNearbyLayout,
  buildSelectedVenueLayout,
  createNearbySearchPort,
  findGatesForSelectedVenue,
  findNearbyGates,
  resolveVenueGeometry,
} from "./venueGeometry";
import { locateViewPlan, type LocateViewPlan } from "./locateView";
import { ensureWalkingPlugin, planEdgeWalking } from "./edgeWalking";
import {
  buildRealRouteNotes,
  mergeRealRoutes,
  plannableEdges,
  type RealEdgeFailure,
  type RealEdgeRoute,
} from "./realRoutePlan";
import { MapOverlayController } from "./overlayController";
import { SIMPLE_UI } from "../features/shell/clientMode";
import type { AmapMapInstance, AmapNamespace, AmapOverlayInstance } from "./types";

interface AmapViewProps {
  scenario: Scenario;
  frame: TimelineFrame | null;
  plan: Plan | null;
  result: SimulationResult | null;
  selectedGroupId: string | null;
  onRequestSvg: () => void;
  /** 可选：用户点选的路线（单向展示输入）。设置时仅该路线加粗，其余淡化 */
  selectedRouteId?: string | null;
  /** 可选：compact=首页嵌入（较矮容器、关闭滚轮缩放避免劫持页面滚动）；默认 full */
  variant?: "full" | "compact";
}

const KIND_LABELS: Record<ScenarioNode["kind"], string> = {
  source: "场馆",
  exit: "出口",
  stop: "接驳点",
};

/** 路线是否途经/终到指定节点 */
function routeServesNode(scenario: Scenario, routeId: string, nodeId: string): boolean {
  const route = scenario.routes.find((r) => r.route_id === routeId);
  if (!route) return false;
  if (route.stop_id === nodeId) return true;
  return route.edge_ids.some((eid) => {
    const e = scenario.edges.find((x) => x.edge_id === eid);
    return e !== undefined && (e.from === nodeId || e.to === nodeId);
  });
}

/**
 * 高德地图展示模式（仅展示，不进入任何计算）。
 * React 层只编排生命周期：地图初始化/销毁、基础覆盖物重建（scenario/geo 变化）、
 * 帧标签更新（frame 变化，绝不增删覆盖物）、路线覆盖重绘（plan/选中组变化）。
 */
export default function AmapView({ scenario, frame, plan, result, selectedGroupId, onRequestSvg, selectedRouteId, variant = "full" }: AmapViewProps) {
  const config = useMemo(() => getMapConfig(scenario), [scenario]);
  const configOk = config.ok;
  const baseGeo: GeoMapping | null = configOk ? config.geo : null;
  // 运行时按真实场馆布点后的覆盖几何（null = 使用环境变量配置的示意映射）
  const [autoGeo, setAutoGeo] = useState<GeoMapping | null>(null);
  const [venueNotes, setVenueNotes] = useState<string[]>([]);
  const [venueBusy, setVenueBusy] = useState(false);
  /** 真实步行动线：按钮触发，逐条调用高德步行规划，仅替换展示折线 */
  const [realRouteBusy, setRealRouteBusy] = useState(false);
  const [realRouteProgress, setRealRouteProgress] = useState<{ done: number; total: number } | null>(null);
  const [realRouteNotes, setRealRouteNotes] = useState<string[]>([]);
  const [realRouteApplied, setRealRouteApplied] = useState(false);
  /** 地理检索/布点请求序号：位置或新请求变化后，旧请求的晚到结果不得覆盖新结果 */
  const geoRequestIdRef = useRef(0);
  const geo: GeoMapping | null = autoGeo ?? baseGeo;

  /** 位置变化或发起新请求时作废旧结果（含正在跑的真实步行动线） */
  function invalidateGeoRequests(): void {
    geoRequestIdRef.current += 1;
    setVenueBusy(false);
    setRealRouteBusy(false);
    setRealRouteProgress(null);
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AmapMapInstance | null>(null);
  const ctlRef = useRef<MapOverlayController | null>(null);
  // 帧/结果的最新值 ref：基础覆盖物重建后按当前帧补一次标签，而不让重建 effect 依赖 frame
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const resultRef = useRef(result);
  resultRef.current = result;
  // variant 的最新值：地图只在初始化时读一次构造选项（变体切换不重建地图）
  const variantRef = useRef(variant);
  variantRef.current = variant;

  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);
  const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  /* ---------- 定位与地点跳转（仅展示层，结果不进入计算） ---------- */
  const amapNsRef = useRef<AmapNamespace | null>(null);
  const userMarkerRef = useRef<AmapOverlayInstance | null>(null);
  const autoLocateTriedRef = useRef(false);
  const [locateState, setLocateState] = useState<
    { kind: "idle" } | { kind: "locating" } | { kind: "ok"; text: string } | { kind: "failed"; text: string }
  >({ kind: "idle" });
  const [keyword, setKeyword] = useState("");
  const [placeCandidates, setPlaceCandidates] = useState<PlaceCandidate[]>([]);
  const [candidateQuery, setCandidateQuery] = useState("");
  /** 只有用户明确确认过的主体 POI 才能进入“查所选场馆出口” */
  const [selectedVenue, setSelectedVenue] = useState<PlaceCandidate | null>(null);
  /** 最近一次设定的位置（定位或地点跳转）：用于“以我的位置搜索附近出口” */
  const [myLocation, setMyLocation] = useState<UserLocation | null>(null);
  // 粗定位（城市级/IP）不得直接作为出口检索圆心，必须先确认具体地点
  const nearbyEligibility = useMemo(
    () => venueExitSearchEligibility(myLocation, selectedVenue !== null),
    [myLocation, selectedVenue]
  );
  const manualVenueConfirmationRequired = myLocation?.source === "manual" && selectedVenue === null;

  /** 放置/替换“我的位置”标记（与场景覆盖物分离管理） */
  function placeUserMarker(loc: UserLocation): void {
    const AMap = amapNsRef.current;
    const map = mapRef.current;
    if (!AMap || !map) return;
    if (userMarkerRef.current) {
      map.remove(userMarkerRef.current);
      userMarkerRef.current = null;
    }
    const marker = new AMap.Marker({
      position: loc.position,
      label: { content: loc.label, direction: "top" },
      zIndex: 120,
    });
    map.add(marker);
    userMarkerRef.current = marker;
  }

  /**
   * 按视野决策移动地图：境外坐标/非法视野不移动（避免地图移到无高德底图的区域而整块空白）。
   * 返回是否真的移动了视野。
   */
  function applyLocateView(plan: LocateViewPlan, pos: [number, number]): boolean {
    const map = mapRef.current;
    if (!map || !plan.move) return false;
    try {
      map.setZoomAndCenter(plan.zoom, pos);
      return true;
    } catch {
      return false;
    }
  }

  async function doLocate(): Promise<void> {
    const AMap = amapNsRef.current;
    const map = mapRef.current;
    if (!AMap || !map) return;
    const locateId = ++geoRequestIdRef.current;
    setLocateState({ kind: "locating" });

    // 权限被拒绝时不会弹授权框，重试必然失败：先给可操作的恢复指引
    const perm = await getGeolocationPermission();
    if (locateId !== geoRequestIdRef.current) return;
    if (perm === "denied") {
      setLocateState({
        kind: "failed",
        text: "浏览器已拒绝定位权限：请点地址栏左侧图标 → 网站设置 → 定位改为“允许”，刷新后再试；或直接输入所在地跳转",
      });
      return;
    }

    // 三层兜底：浏览器精确定位 → 高德 IP 优先定位 → CitySearch 城市级
    const r = await locateWithFallback(
      createGeolocationPort(AMap),
      createCitySearchPort(AMap),
      createIpGeolocationPort(AMap)
    );
    // 期间用户已发起新的定位/地点跳转：旧结果整份丢弃
    if (locateId !== geoRequestIdRef.current) return;
    if (!r.ok) {
      setLocateState({ kind: "failed", text: r.reason });
      return;
    }
    const plan = locateViewPlan(r.location);
    if (!canEnterNearbyDiscovery(r.location, plan.move)) {
      const eligibility = nearbySearchEligibility(r.location);
      const reason = !plan.move ? plan.reason : eligibility.ok ? "定位不可用于附近检索" : eligibility.reason;
      setLocateState({
        kind: "ok",
        text: `${describeLocation(r.location)}；${reason}，已保留当前场馆与路线，可手动搜索并确认具体地点`,
      });
      return;
    }
    placeUserMarker(r.location);
    setMyLocation(r.location);
    setSelectedVenue(null);
    setPlaceCandidates([]);
    setCandidateQuery("");
    // 只有精确且位于国内覆盖范围内的定位，才清旧图并进入附近发现模式
    invalidateGeoRequests();
    setAutoGeo({
      venueName: "当前位置附近",
      coordVerified: false,
      center: r.location.position,
      nodes: { S: r.location.position },
      nodeLabels: { S: r.location.label },
    });
    setVenueNotes(["已切换为定位附近发现模式；上一场馆的出口与路线已清空。"]);
    const moved = applyLocateView(plan, r.location.position);
    setLocateState({
      kind: "ok",
      text: describeLocation(r.location) + (moved ? "" : `；${plan.move ? "地图视野未移动，可点“回到场馆”恢复" : plan.reason}`),
    });
  }

  async function doSearch(): Promise<void> {
    const AMap = amapNsRef.current;
    if (!AMap || !mapRef.current) return;
    const query = keyword.trim();
    if (query === "") {
      setLocateState({ kind: "failed", text: "请输入地点关键词后再查找" });
      return;
    }
    const locateId = ++geoRequestIdRef.current;
    setLocateState({ kind: "locating" });
    try {
      const candidates = await searchPlaceCandidates(createPlaceSearchPort(AMap), query);
      // 输入改变或新请求发起后，旧候选整份丢弃
      if (!candidateResponseMatchesCurrent(locateId, geoRequestIdRef.current, query, keyword)) return;
      setCandidateQuery(query);
      setPlaceCandidates(candidates.slice(0, 6));
      setSelectedVenue(null);
      if (candidates.length === 0) {
        setLocateState({ kind: "failed", text: `未找到与“${query}”匹配的地点，可补充分店名后重试` });
      } else {
        setLocateState({ kind: "ok", text: "请选择并确认主体场馆；停车场等附属设施不能作为场馆主体" });
      }
    } catch (e) {
      if (locateId !== geoRequestIdRef.current) return;
      setPlaceCandidates([]);
      setCandidateQuery(query);
      setLocateState({ kind: "failed", text: e instanceof Error ? e.message : String(e) });
    }
  }

  function confirmPlaceCandidate(candidate: PlaceCandidate): void {
    if (!candidate.isPrincipal || candidate.query !== candidateQuery || !candidateSelectionStillValid(candidateQuery, keyword)) return;
    const location: UserLocation = {
      position: candidate.position,
      source: "manual",
      precision: "manual",
      label: candidate.name,
    };
    placeUserMarker(location);
    setMyLocation(location);
    setSelectedVenue(candidate);
    setPlaceCandidates([]);
    invalidateGeoRequests();
    // 确认新场馆时立即清除上一场馆门/路线；在找到可信门前只保留主体点 S
    setAutoGeo({
      venueName: candidate.name,
      coordVerified: false,
      center: candidate.position,
      nodes: { S: candidate.position },
      nodeLabels: { S: candidate.name },
    });
    setVenueNotes([`已确认主体场馆：${candidate.name}。请点击“查所选场馆出口”。`]);
    setRealRouteApplied(false);
    setRealRouteNotes([]);
    const plan = locateViewPlan(location);
    const moved = applyLocateView(plan, location.position);
    setLocateState({
      kind: "ok",
      text: `已确认并跳转到：${candidate.name}` +
        (moved ? "" : `；${plan.move ? "地图视野未移动，可点“回到场馆”恢复" : plan.reason}`),
    });
  }

  /** 明确恢复默认演示场馆，避免用户误以为仍在操作刚确认的万达等地点。 */
  function restoreDemoVenue(): void {
    const map = mapRef.current;
    invalidateGeoRequests();
    setSelectedVenue(null);
    setPlaceCandidates([]);
    setCandidateQuery("");
    setKeyword("");
    setMyLocation(null);
    setAutoGeo(null);
    setVenueNotes(["已恢复演示场馆（华交）；地图布点仅用于演示，不代表刚才选择的场馆。"]);
    setRealRouteApplied(false);
    setRealRouteNotes([]);
    if (userMarkerRef.current && map) {
      map.remove(userMarkerRef.current);
      userMarkerRef.current = null;
    }
    const center = baseGeo?.center ?? baseGeo?.nodes["S"];
    if (map && center) map.setZoomAndCenter(14, center);
  }

  /**
   * 两种语义严格分开：手动确认地点只查“所选场馆出口”；浏览器定位才查“附近场馆”。
   * 手动模式无可信门时清空旧布局，绝不退回附近学校或默认华交。
   */
  async function doResolveNearby(): Promise<void> {
    const AMap = amapNsRef.current;
    const map = mapRef.current;
    if (!AMap || !map || !myLocation) return;
    // 粗定位不能直接当检索圆心：先要求用户确认具体地点
    if (!nearbyEligibility.ok) {
      setVenueNotes([nearbyEligibility.reason]);
      return;
    }
    const center = myLocation.position;
    const requestId = ++geoRequestIdRef.current;
    setVenueBusy(true);
    // 新的检索作废旧的真实步行动线，避免两套坐标混用
    setRealRouteBusy(false);
    setRealRouteProgress(null);
    try {
      // 城市来源：地图中心即定位点，getCity 拿到所在城市后把 AutoComplete 限定到该城市
      //（实测 AutoComplete 泛词全国检索召回不到具体场馆；POI 又不带 cityname）
      const city = await new Promise<string | undefined>((resolve) => {
        let settled = false;
        const done = (v: string | undefined) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        try {
          if (typeof map.getCity === "function") {
            const timer = setTimeout(() => done(undefined), 3000);
            map.getCity((res: { city?: string }) => {
              clearTimeout(timer);
              done(typeof res?.city === "string" ? res.city : undefined);
            });
          } else {
            done(undefined);
          }
        } catch {
          done(undefined);
        }
      });
      if (requestId !== geoRequestIdRef.current) return;
      const port = createNearbySearchPort(AMap);
      let layout: ReturnType<typeof buildNearbyLayout>;
      if (selectedVenue) {
        const [selected, metro, bus] = await Promise.all([
          findGatesForSelectedVenue(port, selectedVenue, 800, city),
          port.searchNearby("地铁站", center, 1500),
          port.searchNearby("公交站", center, 1500),
        ]);
        if (requestId !== geoRequestIdRef.current) return;
        layout = buildSelectedVenueLayout(selectedVenue, selected.gates, [...metro, ...bus].slice(0, 2));
      } else {
        // 只有浏览器精确定位会进入此分支；它的语义是发现当前位置附近的场馆。
        if (myLocation.source !== "geolocation") {
          setVenueNotes(["请重新搜索并确认主体场馆后，再查所选场馆出口"]);
          return;
        }
        const [{ gates, venues }, metro, bus] = await Promise.all([
          findNearbyGates(port, center, 3000, {
            city,
            venueKeyword: baseGeo?.venueName ?? scenario.title,
            venueAnchor: baseGeo?.center ?? baseGeo?.nodes["S"],
          }),
          port.searchNearby("地铁站", center, 3000),
          port.searchNearby("公交站", center, 3000),
        ]);
        if (requestId !== geoRequestIdRef.current) return;
        layout = buildNearbyLayout(center, venues, gates, [...metro, ...bus].slice(0, 2));
      }
      setAutoGeo(layout.geo);
      setRealRouteApplied(false);
      setRealRouteNotes([]);
      setVenueNotes(layout.notes);
      map.setZoomAndCenter(15, layout.geo.center ?? layout.geo.nodes["S"]);
    } catch (e) {
      if (requestId !== geoRequestIdRef.current) return;
      setVenueNotes([`${selectedVenue ? "所选场馆" : "附近场馆"}出口检索失败：${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      if (requestId === geoRequestIdRef.current) setVenueBusy(false);
    }
  }

  /**
   * 真实步行动线（展示层）：逐条通道调用高德步行规划，用真实折线替换示意直线。
   * - 尚未解析真实场馆时先复用“按真实场馆布点”；
   * - 失败通道保留原示意线并如实说明，绝不用直线冒充真实路线；
   * - 只写 geo.edges，不进入 Scenario / Plan / 推演计算。
   */
  async function doPlanRealRoutes(): Promise<void> {
    const AMap = amapNsRef.current;
    const map = mapRef.current;
    if (!AMap || !map || realRouteBusy) return;
    const requestId = ++geoRequestIdRef.current;
    setRealRouteBusy(true);
    // 新的规划作废在途的场馆检索，避免其晚到覆盖本次结果
    setVenueBusy(false);
    setRealRouteNotes([]);
    setRealRouteProgress(null);
    try {
      let workGeo = geo;
      if (!workGeo) {
        setRealRouteNotes(["当前没有可用的节点坐标，无法规划真实步行动线"]);
        return;
      }

      if (!autoGeo) {
        setRealRouteNotes(["正在解析真实场馆布点…"]);
        try {
          const g = await resolveVenueGeometry(
            createNearbySearchPort(AMap),
            baseGeo?.venueName ?? scenario.title,
            baseGeo
          );
          if (requestId !== geoRequestIdRef.current) return;
          if (g) {
            workGeo = g.geo;
            setAutoGeo(g.geo);
            setVenueNotes(g.notes);
            map.setZoomAndCenter(15, g.geo.center ?? g.geo.nodes["S"]);
          } else {
            setRealRouteNotes(["未能解析真实场馆，改用当前配置布点规划；路线走向来自高德，起终点为配置坐标"]);
          }
        } catch (e) {
          if (requestId !== geoRequestIdRef.current) return;
          setRealRouteNotes([
            `真实场馆解析失败（${e instanceof Error ? e.message : String(e)}），改用当前配置布点规划`,
          ]);
        }
      }

      const edges = plannableEdges(scenario, workGeo);
      if (edges.length === 0) {
        setRealRouteNotes(["当前没有可规划的通道（已关闭或缺少坐标）"]);
        return;
      }
      setRealRouteProgress({ done: 0, total: edges.length });

      try {
        await ensureWalkingPlugin(AMap);
      } catch (e) {
        setRealRouteNotes([`无法加载高德步行插件：${e instanceof Error ? e.message : String(e)}，保留模拟示意线`]);
        return;
      }

      const routes: RealEdgeRoute[] = [];
      const failures: RealEdgeFailure[] = [];
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const from = workGeo.nodes[edge.from];
        const to = workGeo.nodes[edge.to];
        let outcome = await planEdgeWalking(AMap, from, to);
        // 高德偶发限流/瞬时失败：间隔 700ms 重试一次；仍失败则如实保留示意线
        if (!outcome.ok) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          outcome = await planEdgeWalking(AMap, from, to);
        }
        // 期间用户换了地点或发起了新请求：立即停止，不写入旧结果
        if (requestId !== geoRequestIdRef.current) return;
        if (outcome.ok) {
          routes.push({ edge_id: edge.edge_id, ...outcome.value });
        } else {
          failures.push({ edge_id: edge.edge_id, reason: outcome.reason });
        }
        setRealRouteProgress({ done: i + 1, total: edges.length });
      }

      if (requestId !== geoRequestIdRef.current) return;
      if (routes.length > 0) {
        setAutoGeo((prev) => mergeRealRoutes(prev ?? workGeo, routes));
        setRealRouteApplied(true);
      }
      setRealRouteNotes(buildRealRouteNotes(edges, routes, failures));
    } finally {
      if (requestId === geoRequestIdRef.current) {
        setRealRouteBusy(false);
        setRealRouteProgress(null);
      }
    }
  }

  /* ---------- 地图初始化与销毁（SDK 单例；卸载即 dispose + destroy；失败可显式重试） ---------- */
  useEffect(() => {
    if (!configOk) return;
    let disposed = false;
    setStatus("loading");
    setError(null);
    loadAmap(config.key, config.serviceHost)
      .then((AMap) => {
        if (disposed || !containerRef.current || !config.ok) return;
        const center =
          config.geo.center ?? config.geo.nodes["S"] ?? Object.values(config.geo.nodes)[0];
        const map = new AMap.Map(containerRef.current, {
          viewMode: "2D",
          zoom: 14,
          center,
          // compact：滚轮缩放交给页面纵向滚动，避免嵌入地图劫持滚轮
          scrollWheel: variantRef.current !== "compact",
        });
        mapRef.current = map;
        amapNsRef.current = AMap;
        const ctl = new MapOverlayController(AMap, map);
        ctl.onNodeClick = (nodeId) => setInfoNodeId(nodeId);
        ctlRef.current = ctl;
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (!disposed) {
          setStatus("failed");
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      // 组件卸载或重试前：迟到完成的 load 因 disposed 不会创建地图；已建地图整体销毁
      disposed = true;
      ctlRef.current?.dispose();
      ctlRef.current = null;
      amapNsRef.current = null;
      userMarkerRef.current = null; // 随 map.destroy 一并销毁
      autoLocateTriedRef.current = false;
      const map = mapRef.current;
      mapRef.current = null;
      try {
        map?.destroy();
      } catch {
        /* 销毁失败不阻塞卸载 */
      }
    };
    // retryNonce：用户点击“重试加载”时递增，重新执行初始化
  }, [configOk, retryNonce]);

  /* ---------- 优先呈现定位所在地：地图就绪后自动尝试一次（失败停留在场馆并如实提示） ---------- */
  useEffect(() => {
    if (status !== "ready" || autoLocateTriedRef.current) return;
    autoLocateTriedRef.current = true;
    void doLocate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  /* ---------- 基础覆盖物：仅 scenario / geo 变化时重建（与帧更新彻底分离） ---------- */
  useEffect(() => {
    if (status !== "ready" || !geo) return;
    const ctl = ctlRef.current;
    if (!ctl) return;
    ctl.rebuildBase(scenario, geo);
    ctl.applyFrame(scenario, geo, frameRef.current, resultRef.current);
  }, [status, scenario, geo]);

  /* ---------- 帧标签更新：只改文字，不增删覆盖物 ---------- */
  useEffect(() => {
    if (status !== "ready" || !geo) return;
    ctlRef.current?.applyFrame(scenario, geo, frame, result);
  }, [status, scenario, geo, frame, result]);

  /* ---------- 路线分配覆盖物：plan / 选中组 / 选中路线变化时重绘（先清旧） ---------- */
  useEffect(() => {
    if (status !== "ready" || !geo) return;
    ctlRef.current?.rebuildRoutes(scenario, geo, plan, selectedGroupId, selectedRouteId);
  }, [status, scenario, geo, plan, selectedGroupId, selectedRouteId]);

  /* ---------- 节点信息窗 ---------- */
  useEffect(() => {
    if (status !== "ready" || !geo || !infoNodeId) return;
    ctlRef.current?.showNodeInfo(scenario, geo, frame, infoNodeId);
  }, [status, scenario, geo, frame, infoNodeId]);

  /* ---------- 渲染 ---------- */

  if (!configOk) {
    return (
      <div className="amap-fallback">
        <h3>高德地图未配置</h3>
        <p>缺少以下配置项（见 web/.env.example，凭据不入源码）：</p>
        <ul>
          {config.missing.map((m) => (
            <li key={m} className="mono">{m}</li>
          ))}
        </ul>
        {config.issues.length > 0 && (
          <ul className="field-errors">
            {config.issues.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ul>
        )}
        <p className="dim">未配置坐标时不展示地图，也不会把随意坐标包装成真实场地。</p>
        <button className="btn" onClick={onRequestSvg}>查看示意图</button>
      </div>
    );
  }

  const infoNode = infoNodeId ? scenario.nodes.find((n) => n.node_id === infoNodeId) ?? null : null;
  const infoNodeMapLabel = infoNode ? geo?.nodeLabels?.[infoNode.node_id] : undefined;
  const infoAllocation =
    infoNode && plan
      ? plan.allocations
          .map((a) => ({ group_id: a.group_id, routes: a.routes.filter((r) => routeServesNode(scenario, r.route_id, infoNode.node_id)) }))
          .filter((x) => x.routes.length > 0)
      : [];

  return (
    <div>
      <div className="amap-toolbar">
        {/* 常驻只保留定位与地点跳转；其余工具收进折叠区，并统一放大触控区（≥44px） */}
        <div className="amap-toolbar-row">
          <button
            className="btn btn-small"
            disabled={status !== "ready" || locateState.kind === "locating"}
            onClick={() => void doLocate()}
          >
            {locateState.kind === "locating" ? "定位中…" : "定位到我的位置"}
          </button>
          <input
            type="text"
            placeholder="输入场馆完整名称（含分店/校区）"
            value={keyword}
            disabled={status !== "ready"}
            onChange={(e) => {
              const next = e.target.value;
              setKeyword(next);
              // 输入一改，旧候选与旧确认立即失效；在途响应也不得回来覆盖
              invalidateGeoRequests();
              setPlaceCandidates([]);
              setCandidateQuery("");
              setLocateState({ kind: "idle" });
              if (selectedVenue) {
                setAutoGeo({
                  venueName: "待确认新地点",
                  coordVerified: false,
                  center: selectedVenue.position,
                  nodes: { S: selectedVenue.position },
                  nodeLabels: { S: selectedVenue.name },
                });
                setVenueNotes(["地点输入已更改，上一场馆确认和出口已失效；请重新查找并确认主体场馆。"]);
              }
              setSelectedVenue(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doSearch();
            }}
          />
          <button
            className="btn btn-small"
            disabled={status !== "ready" || locateState.kind === "locating"}
            onClick={() => void doSearch()}
          >
            查找候选
          </button>
        </div>

        {placeCandidates.length > 0 && candidateSelectionStillValid(candidateQuery, keyword) && (
          <div className="panel" style={{ marginTop: 6, padding: "8px 10px" }}>
            <b style={{ fontSize: 13 }}>请确认主体场馆</b>
            <div className="dim" style={{ fontSize: 12, margin: "2px 0 6px" }}>
              原输入：{candidateQuery}。附属停车场/出入口只展示，不可冒充主体。
            </div>
            {placeCandidates.map((candidate, index) => (
              <div className="row" key={`${candidate.id ?? candidate.name}-${index}`} style={{ marginTop: 4 }}>
                <span style={{ fontSize: 12 }}>
                  {candidate.name}
                  {candidate.type ? <span className="dim">｜{candidate.type}</span> : null}
                  {candidate.address ? <span className="dim">｜{candidate.address}</span> : null}
                </span>
                <span className="spacer" />
                <button
                  className="btn btn-small"
                  disabled={!candidate.isPrincipal}
                  title={candidate.isPrincipal ? "确认此主体并跳转" : "这是附属设施，不能作为主体场馆"}
                  onClick={() => confirmPlaceCandidate(candidate)}
                >
                  {candidate.isPrincipal ? "确认此场馆" : "附属设施"}
                </button>
              </div>
            ))}
          </div>
        )}

        <details className="amap-more-tools">
          <summary>更多地图工具（视野 / 真实布点 / 找附近出口）</summary>
          <div className="amap-toolbar-row">
            <button className="btn btn-small" disabled={status !== "ready"} onClick={() => mapRef.current?.setFitView(null, false, [60, 60, 60, 60])}>
              适配全部节点
            </button>
            <button
              className="btn btn-small"
              disabled={status !== "ready" || !geo?.nodes["S"]}
              onClick={() => {
                const s = geo?.nodes["S"];
                if (s) mapRef.current?.setZoomAndCenter(14, s);
              }}
            >
              回到场馆
            </button>
            <button
              className="btn btn-small"
              disabled={status !== "ready"}
              title="明确切回默认演示场馆华东交通大学，不会继续操作刚才选择的地点"
              onClick={restoreDemoVenue}
            >
              恢复演示场馆（华交）
            </button>
            <button
              className="btn btn-small"
              disabled={status !== "ready" || venueBusy || realRouteBusy}
              title="对每条通道调用高德步行规划，用真实折线替换示意直线；只影响展示，不进入推演"
              onClick={() => void doPlanRealRoutes()}
            >
              {realRouteBusy
                ? realRouteProgress
                  ? `规划中 ${realRouteProgress.done}/${realRouteProgress.total}`
                  : "规划中…"
                : "真实步行动线"}
            </button>
            <button
              className="btn btn-small"
              disabled={status !== "ready" || venueBusy || !nearbyEligibility.ok}
              title={
                nearbyEligibility.ok
                  ? selectedVenue
                    ? `只查已确认的“${selectedVenue.name}”出口；无可信结果会清空旧布局`
                    : "以浏览器精确定位为圆心，发现附近场馆的出入口"
                  : nearbyEligibility.reason
              }
              onClick={() => void doResolveNearby()}
            >
              {venueBusy
                ? "检索中…"
                : selectedVenue
                  ? "查所选场馆出口"
                  : manualVenueConfirmationRequired
                    ? "请先确认主体场馆"
                    : "查定位附近场馆出口"}
            </button>
          </div>
          {myLocation !== null && !nearbyEligibility.ok && (
            <p className="dim" style={{ fontSize: 12, margin: "6px 0 0" }}>
              {nearbyEligibility.reason}
            </p>
          )}
        </details>
      </div>

      {locateState.kind === "ok" && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>{locateState.text}（仅视野展示，不参与推演）</div>
      )}
      {locateState.kind === "failed" && (
        <div className="banner banner-warn" style={{ marginBottom: 6 }}>{locateState.text}</div>
      )}

      {venueNotes.length > 0 && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
          {venueNotes.map((n) => (
            <div key={n}>· {n}</div>
          ))}
        </div>
      )}

      {realRouteNotes.length > 0 && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
          {realRouteNotes.map((n) => (
            <div key={n}>· {n}</div>
          ))}
        </div>
      )}

      {geo && !geo.coordVerified && !SIMPLE_UI && (
        <div className="banner banner-warn">
          场地位置未经核实，仅作布局示意。
          <details className="banner-detail">
            <summary>说明</summary>
            场地「{geo.venueName}」坐标为 GCJ-02 展示映射（coordVerified=false，仅加载验证/POI 检索），未经实地核实，
            不作为真实场地依据；展示映射不进入任何计算模型，场景计算不受影响。队列/登车等数据与底图无关，均来自同一份模拟结果。
          </details>
        </div>
      )}
      {geo && !geo.coordVerified && SIMPLE_UI && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>坐标来自高德 POI，未实地核实，仅作布局示意。</div>
      )}

      <div
        className="amap-container"
        ref={containerRef}
        style={variant === "compact" ? { height: "clamp(280px, 46vh, 400px)" } : undefined}
      >
        {status === "loading" && <div className="amap-status">高德地图 SDK 加载中…</div>}
        {status === "failed" && (
          <div className="amap-status">
            <div className="banner banner-danger" style={{ margin: 8 }}>
              高德 SDK 加载失败：{error ?? "未知错误"}。不会影响既有 SVG、编辑、比较与回放功能。
            </div>
          </div>
        )}
      </div>
      {status === "failed" && (
        <div className="row section-gap">
          <button className="btn" onClick={() => setRetryNonce((n) => n + 1)}>
            重试加载（上一次挂起的请求已丢弃，将重新发起）
          </button>
          <button className="btn" onClick={onRequestSvg}>查看示意图</button>
        </div>
      )}

      {infoNode && (
        <div className="panel" style={{ marginTop: 8, padding: "8px 12px" }}>
          <div className="row">
            <b>
              {infoNodeMapLabel ?? `${KIND_LABELS[infoNode.kind]} ${infoNode.node_id}`}
              {infoNodeMapLabel ? `（演示映射 ${infoNode.node_id}）` : ""}
            </b>
            <span className="dim" style={{ fontSize: 12 }}>
              当前帧排队 {frame?.node_queues[infoNode.node_id] ?? 0} 人
              {infoNode.kind === "stop" && result && frame
                ? `｜累计登车 ${result.departures_log.filter((d) => d.stop_id === infoNode.node_id && d.depart_s <= frame.t_s).reduce((s, d) => s + d.boarded_count, 0)} 人`
                : ""}
            </span>
            <span className="spacer" />
            <button className="btn btn-small" onClick={() => setInfoNodeId(null)}>关闭</button>
          </div>
          {infoAllocation.length > 0 ? (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              途经/终到该节点的分配：
              {infoAllocation.map((x) => (
                <span key={x.group_id} className="badge" style={{ marginLeft: 4 }}>
                  {x.group_id} → {x.routes.map((r) => `${r.route_id} ${(r.share * 100).toFixed(0)}%`).join("、")}
                </span>
              ))}
              <span className="dim">（可在需求选择区切换组视角查看该组）</span>
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>当前方案无途经/终到该节点的分配。</div>
          )}
        </div>
      )}

      <div className="sandbox-legend">
        <span>■场馆 ●出口 ◆接驳点</span>
        <span>实线=无台阶通道</span>
        <span style={{ color: "#b45309" }}>虚线=含台阶</span>
        <span style={{ color: "#b91c1c" }}>红色虚线+✕=已关闭</span>
        <span>蓝色粗线=当前选中路线</span>
        <span>{realRouteApplied ? "折线=高德步行规划；直线=模拟通道示意" : "未配置几何的连线均为“模拟通道示意”"}</span>
        <span>底图 © 高德地图；聚合数据为模拟结果，非真实客流</span>
      </div>
    </div>
  );
}

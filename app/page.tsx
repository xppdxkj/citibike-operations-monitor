"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  Bike,
  Boxes,
  BrainCircuit,
  CalendarRange,
  Check,
  ChevronRight,
  CircleDot,
  CloudSun,
  Database,
  Gauge,
  Layers3,
  MapPin,
  Menu,
  RefreshCw,
  Route,
  Search,
  SlidersHorizontal,
  Sparkles,
  TimerReset,
  TrendingUp,
  Truck,
  X,
  Zap,
} from "lucide-react";

type ViewKey = "overview" | "forecast" | "dispatch" | "history" | "model";
type RiskType = "shortage" | "overflow" | "balanced";

type Station = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number;
  bikes: number;
  docks: number;
  disabled: number;
  ebikes: number;
  online: boolean;
  lastReported: number;
  serviceState: "operational" | "offline" | "stale" | "invalid_capacity";
};

type LivePayload = {
  source: "live" | "fallback";
  updatedAt: number;
  stations: Station[];
  weather: null | Record<string, number | string>;
  analytics?: LiveAnalytics;
  snapshot?: { persisted: boolean; bucket?: number; intervalSeconds?: number; trigger?: string; reason?: string };
};

type LiveRegion = {
  name: string; stations: number; bikes: number; docks: number; ebikes: number; disabled: number;
  emptyStations: number; fullStations: number; offlineStations: number; bikeShare: number; fillRate: number;
};

type LiveAnalytics = {
  totals: { bikes: number; docks: number; ebikes: number; disabled: number; onlineStations: number; operationalStations: number; offlineStations: number; emptyStations: number; fullStations: number; staleStations: number; invalidCapacityStations: number };
  regions: LiveRegion[];
  availability: Array<{ label: string; count: number }>;
  freshness: { sourceAgeSeconds: number; staleStations: number; completeness: number; measuredAt: number };
};

type TripAnalytics = {
  meta: { month: string; rawRows: number; validRides: number; activeDays: number; stations: number; avgDuration: number; filters: string };
  users: Array<{ type: string; rides: number; share: number; avgDuration: number; weekendShare: number; electricShare: number; avgDistance: number; peakHour: number }>;
  bikes: Array<{ type: string; rides: number; share: number; avgDuration: number; memberShare: number; avgDistance: number }>;
  regions: Array<{ name: string; starts: number; ends: number; netFlow: number; share: number; memberShare: number; electricShare: number; avgDuration: number; avgDistance: number; peakHour: number }>;
  hourly: Array<{ label: string; member: number; casual: number }>;
  weekday: Array<{ label: string; member: number; casual: number }>;
  timeBands: Array<{ label: string; member: number; casual: number }>;
  durationBands: Array<{ label: string; member: number; casual: number }>;
  distanceBands: Array<{ label: string; member: number; casual: number; avgDuration: number }>;
  distanceModel: { samples: number; r2: number; distanceElasticity: number; electricDurationEffectPct: number; casualDurationEffectPct: number; method: string };
  weather: null | {
    source: string; matchedHours: number; controlledModelR2: number; method: string;
    correlations: Array<{ factor: string; correlation: number }>;
    controlledEffects: Array<{ factor: string; effectPct: number }>;
    rainImpact: Array<{ label: string; hours: number; avgRides: number; demandIndex: number }>;
    temperatureImpact: Array<{ label: string; hours: number; avgRides: number; demandIndex: number }>;
  };
  topRoutes: Array<{ start: string; end: string; rides: number }>;
  topStartStations: Array<{ name: string; rides: number }>;
};

type SnapshotAnalytics = {
  available: boolean;
  collection: { snapshots: number; firstAt: number | null; lastAt: number | null; spanMinutes: number; mode: string };
  system: Array<Record<string, number>>;
  regions: Array<Record<string, number | string>>;
  baseline: { pairs?: number; mae_30m?: number | null };
  station: StationSnapshot[];
};

type StationSnapshot = {
  snapshot_at: number;
  station_id: string;
  station_name: string;
  bikes: number;
  docks: number;
  capacity: number;
  risk_type: string;
  risk_score: number;
};

type DerivedStation = Station & {
  ratio: number;
  risk: number;
  riskType: RiskType;
  projectedBikes: number;
  change: number;
  actionable: boolean;
};

type RebalanceTask = {
  id: string;
  sourceId: string;
  targetId: string;
  source: string;
  target: string;
  amount: number;
  priority: string;
  rank: number;
  risk: number;
  distanceKm: number;
};

function straightLineKm(a: Pick<Station, "lat" | "lon">, b: Pick<Station, "lat" | "lon">) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * sinLon * sinLon;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const nav = [
  { id: "overview" as const, label: "实时运营", note: "全网状态与风险", icon: Gauge },
  { id: "forecast" as const, label: "站点诊断", note: "库存、趋势与阈值", icon: TrendingUp },
  { id: "dispatch" as const, label: "调度复核", note: "配对、地图与详情", icon: Route },
  { id: "history" as const, label: "经营分析", note: "区域、用户与偏好", icon: CalendarRange },
  { id: "model" as const, label: "模型中心", note: "数据、基线与上线门槛", icon: BrainCircuit },
];

const viewMeta: Record<ViewKey, { eyebrow: string; title: string; subtitle: string }> = {
  overview: { eyebrow: "LIVE OPERATIONS", title: "实时运营中心", subtitle: "把当前库存告警、站点详情和调度复核入口放在同一张地图上" },
  forecast: { eyebrow: "STATION DIAGNOSTICS", title: "站点库存诊断", subtitle: "查看真实库存轨迹、服务状态、阈值告警和数据积累情况" },
  dispatch: { eyebrow: "REBALANCE REVIEW", title: "调度复核工作台", subtitle: "逐条检查调出站、调入站、距离、数量和搬运后的库存变化" },
  history: { eyebrow: "BUSINESS ANALYTICS", title: "骑行业务分析", subtitle: "基于真实月度骑行明细分析区域热度、用户结构、车辆偏好与出行规律" },
  model: { eyebrow: "MODEL OPS", title: "模型与数据监控", subtitle: "明确区分实时数据、库存不变对照法和待训练模型" },
};

const fallbackData: LivePayload = {
  source: "fallback",
  updatedAt: 0,
  weather: { temperature_2m: 25.4, apparent_temperature: 26.1, precipitation: 0, wind_speed_10m: 11.8 },
  stations: [],
};

const number = new Intl.NumberFormat("zh-CN");
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function basemapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        // Keep map requests on the same origin. The server fetches CARTO so mobile
        // browsers do not need a second, sometimes slow or blocked, CDN connection.
        tiles: ["/api/map-tiles/{z}/{x}/{y}"],
        tileSize: 256,
        attribution: "© OpenStreetMap © CARTO",
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto", paint: { "raster-opacity": 0.82 } }],
  };
}

function deriveStation(station: Station): DerivedStation {
  const actionable = station.serviceState === "operational";
  const capacity = actionable ? station.capacity : Math.max(0, station.capacity);
  const safeCapacity = Math.max(1, capacity);
  const ratio = station.bikes / safeCapacity;
  const lower = Math.max(3, Math.round(safeCapacity * 0.12));
  const upper = Math.max(3, Math.round(safeCapacity * 0.12));
  const shortagePressure = clamp((lower - station.bikes) / lower, 0, 1);
  const overflowPressure = clamp((upper - station.docks) / upper, 0, 1);
  const riskType: RiskType = !actionable ? "balanced" : shortagePressure > 0 ? "shortage" : overflowPressure > 0 ? "overflow" : "balanced";
  const baseRisk = Math.max(shortagePressure, overflowPressure) * 78;
  const uncertainty = riskType === "balanced" ? Math.max(0, 22 - Math.abs(ratio - 0.5) * 55) : 18;
  const risk = actionable ? clamp(Math.round(baseRisk + uncertainty), 4, 99) : 0;
  const change = 0;
  const projectedBikes = station.bikes;
  return { ...station, capacity, ratio, risk, riskType, projectedBikes, change, actionable };
}

function serviceStateLabel(station?: Pick<Station, "serviceState">) {
  if (!station) return "未选择";
  if (station.serviceState === "operational") return "服务正常";
  if (station.serviceState === "invalid_capacity") return "容量数据无效";
  if (station.serviceState === "stale") return "数据超过10分钟未更新";
  return "站点暂停服务";
}

function BikeMap({ stations, selectedId, onSelect }: { stations: DerivedStation[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const geojson = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: stations.map((station) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [station.lon, station.lat] },
      properties: { id: station.id, name: station.name, bikes: station.bikes, docks: station.docks, risk: station.risk, riskType: station.riskType, serviceState: station.serviceState, selected: station.id === selectedId ? 1 : 0 },
    })),
  }), [stations, selectedId]);
  const latestGeojsonRef = useRef(geojson);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [-73.9855, 40.739],
      zoom: 11.6,
      attributionControl: false,
      style: basemapStyle(),
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("style.load", () => {
      map.addSource("stations", { type: "geojson", data: latestGeojsonRef.current });
      map.addLayer({
        id: "station-glow",
        type: "circle",
        source: "stations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "risk"], 0, 5, 100, 15],
          "circle-color": ["match", ["get", "serviceState"], "operational", ["match", ["get", "riskType"], "shortage", "#ef6a5b", "overflow", "#f0a33a", "#4d78f0"], "#8d97aa"],
          "circle-opacity": 0.13,
          "circle-blur": 0.6,
        },
      });
      map.addLayer({
        id: "station-points",
        type: "circle",
        source: "stations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 7],
          "circle-color": ["match", ["get", "serviceState"], "operational", ["match", ["get", "riskType"], "shortage", "#ef6a5b", "overflow", "#f0a33a", "#4d78f0"], "#8d97aa"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2,
          "circle-opacity": 0.92,
        },
      });
      map.addLayer({
        id: "selected-station-ring",
        type: "circle",
        source: "stations",
        filter: ["==", ["get", "selected"], 1],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 18],
          "circle-color": "rgba(255,255,255,0)",
          "circle-stroke-color": "#171c3d",
          "circle-stroke-width": 4,
          "circle-opacity": 1,
        },
      });
      map.on("click", "station-points", (event) => {
        const id = String(event.features?.[0]?.properties?.id ?? "");
        if (id) onSelect(id);
      });
      map.on("mouseenter", "station-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "station-points", () => { map.getCanvas().style.cursor = ""; });
    });
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    const resizeMap = () => map.resize();
    window.addEventListener("pageshow", resizeMap);
    window.addEventListener("orientationchange", resizeMap);
    mapRef.current = map;
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("pageshow", resizeMap);
      window.removeEventListener("orientationchange", resizeMap);
      map.remove();
      mapRef.current = null;
    };
  }, [onSelect]);

  useEffect(() => {
    latestGeojsonRef.current = geojson;
    const source = mapRef.current?.getSource("stations") as maplibregl.GeoJSONSource | undefined;
    source?.setData(geojson);
  }, [geojson]);

  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const station = stations.find((item) => item.id === selectedId);
    if (station) mapRef.current.easeTo({ center: [station.lon, station.lat], zoom: Math.max(mapRef.current.getZoom(), 13), duration: 650 });
  }, [selectedId, stations]);

  return <div ref={containerRef} className="map-canvas" aria-label="纽约 Citi Bike 站点风险地图" />;
}

export default function Home() {
  const [view, setView] = useState<ViewKey>("overview");
  const [live, setLive] = useState<LivePayload>(fallbackData);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState("");
  const [lastClientRefresh, setLastClientRefresh] = useState<Date | null>(null);
  const [tripAnalytics, setTripAnalytics] = useState<TripAnalytics | null>(null);
  const [snapshotAnalytics, setSnapshotAnalytics] = useState<SnapshotAnalytics | null>(null);
  const [stationHistory, setStationHistory] = useState<StationSnapshot[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/live?t=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json() as LivePayload;
      setLive(payload);
      setLastClientRefresh(new Date());
      const historyResponse = await fetch(`/api/analytics?t=${Date.now()}`, { cache: "no-store" });
      setSnapshotAnalytics(await historyResponse.json() as SnapshotAnalytics);
    } catch {
      setLive(fallbackData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 300_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    fetch("/data/trip-analytics.json").then((response) => response.json()).then((payload: TripAnalytics) => setTripAnalytics(payload)).catch(() => setTripAnalytics(null));
  }, []);

  const stations = useMemo(() => live.stations.map((station) => deriveStation(station)), [live.stations]);
  const riskStations = useMemo(() => stations.filter((station) => station.actionable && station.riskType !== "balanced").sort((a, b) => b.risk - a.risk), [stations]);
  const shortageStations = useMemo(() => stations.filter((station) => station.riskType === "shortage").sort((a, b) => b.risk - a.risk), [stations]);
  const overflowStations = useMemo(() => stations.filter((station) => station.riskType === "overflow").sort((a, b) => b.risk - a.risk), [stations]);
  const selected = stations.find((station) => station.id === selectedId) ?? riskStations[0] ?? stations[0];

  useEffect(() => {
    if (!selected?.id) return;
    let active = true;
    fetch(`/api/analytics?stationId=${encodeURIComponent(selected.id)}&t=${Date.now()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SnapshotAnalytics) => { if (active) setStationHistory(payload.station ?? []); })
      .catch(() => { if (active) setStationHistory([]); });
    return () => { active = false; };
  }, [selected?.id, live.updatedAt]);
  const visibleStationHistory = stationHistory[0]?.station_id === selected?.id ? stationHistory : [];

  const totals = useMemo(() => stations.reduce((acc, station) => ({
    bikes: acc.bikes + (station.actionable ? station.bikes : 0),
    docks: acc.docks + (station.actionable ? station.docks : 0),
    ebikes: acc.ebikes + (station.actionable ? station.ebikes : 0),
    disabled: acc.disabled + station.disabled,
    online: acc.online + Number(station.online),
  }), { bikes: 0, docks: 0, ebikes: 0, disabled: 0, online: 0 }), [stations]);

  const tasks = useMemo<RebalanceTask[]>(() => {
    const remainingSpare = new Map(overflowStations.map((station) => [station.id, Math.max(0, station.bikes - Math.round(station.capacity * .62))]));
    const result: RebalanceTask[] = [];
    for (const target of shortageStations.slice(0, 12)) {
      const source = overflowStations.reduce<DerivedStation | undefined>((nearest, candidate) => {
        if ((remainingSpare.get(candidate.id) ?? 0) < 3) return nearest;
        if (!nearest) return candidate;
        return straightLineKm(candidate, target) < straightLineKm(nearest, target) ? candidate : nearest;
      }, undefined);
      if (!source) continue;
      const amount = Math.min(12, Math.max(0, Math.round(target.capacity * .28) - target.bikes), remainingSpare.get(source.id) ?? 0);
      if (amount < 1) continue;
      remainingSpare.set(source.id, (remainingSpare.get(source.id) ?? 0) - amount);
      const rank = result.length + 1;
      result.push({
        id: `RB-${String(rank).padStart(3, "0")}`,
        sourceId: source.id, targetId: target.id, source: source.name, target: target.name,
        amount, priority: target.risk >= 90 ? "紧急" : target.risk >= 75 ? "高" : "中",
        rank, risk: target.risk, distanceKm: Number(straightLineKm(source, target).toFixed(2)),
      });
      if (result.length === 6) break;
    }
    return result;
  }, [shortageStations, overflowStations]);

  const navigate = (target: ViewKey) => { setView(target); setMobileNav(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const updatedLabel = live.updatedAt ? new Date(live.updatedAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--:--";
  const temperature = Number(live.weather?.temperature_2m ?? 25.4).toFixed(1);
  const wind = Number(live.weather?.wind_speed_10m ?? 11.8).toFixed(1);
  const precipitation = Number(live.weather?.precipitation ?? 0).toFixed(1);

  const selectStation = useCallback((id: string) => setSelectedId(id), []);
  const openTask = useCallback((id: string) => { setSelectedTaskId(id); navigate("dispatch"); }, []);

  return <main className="app-shell">
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
      <div className="brand"><span><Bike size={22} /></span><div><strong>Citi Bike Ops</strong><small>实时运营 · 调度复核</small></div><button className="nav-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={17} /></button></div>
      <div className="nav-caption">运营工作台</div>
      <nav>{nav.map((item) => <button data-testid={`nav-${item.id}`} key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}><item.icon size={18} /><span><b>{item.label}</b><small>{item.note}</small></span><ChevronRight size={13} className="nav-arrow" /></button>)}</nav>
      <div className="pipeline-card"><div><span className={`live-dot ${live.source === "fallback" ? "demo" : ""}`} /><b>{live.source === "live" ? "GBFS 实时链路正常" : "实时源回退中"}</b></div><strong>{number.format(stations.length)}</strong><small>当前站点 · {updatedLabel}</small><div className="pipeline"><i className={live.source === "live" ? "done" : "active"} /><i className={live.snapshot?.persisted ? "done" : "active"} /><i className={tripAnalytics ? "done" : "active"} /><i /></div><p>实时源 → D1快照 → 月度聚合 → 模型未上线</p></div>
    </aside>

    {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航遮罩" />}

    <section className="workspace">
      <header className="topbar">
        <div className="topbar-title"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={19} /></button><div><span className="page-kicker">{viewMeta[view].eyebrow}</span><h1>{viewMeta[view].title}</h1><p>{viewMeta[view].subtitle}</p></div></div>
        <div className="topbar-actions"><span className="weather-pill"><CloudSun size={15} /><b>{temperature}°</b><span>降雨 {precipitation} mm</span></span><span className="data-badge"><i />{live.source === "live" ? `实时更新 ${updatedLabel}` : "演示数据 · 实时源重连中"}</span><button className="soft-button" onClick={() => window.print()}><ArrowDownToLine size={15} />导出</button><button className="primary-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""} />{loading ? "更新中" : "刷新数据"}</button></div>
      </header>

      <div className="dashboard-stage">
        {view === "overview" && <OverviewView stations={stations} totals={totals} riskStations={riskStations} tasks={tasks} selectedId={selected?.id ?? null} onSelect={selectStation} onOpenTask={openTask} temperature={temperature} wind={wind} navigate={navigate} analytics={live.analytics} snapshot={live.snapshot} />}
        {view === "forecast" && <ForecastView stations={stations} riskStations={riskStations} selected={selected} setSelectedId={setSelectedId} stationHistory={visibleStationHistory} query={query} setQuery={setQuery} />}
        {view === "dispatch" && <DispatchView tasks={tasks} stations={stations} shortageStations={shortageStations} overflowStations={overflowStations} selectedTaskId={selectedTaskId} setSelectedTaskId={setSelectedTaskId} />}
        {view === "history" && <HistoryView data={tripAnalytics} liveAnalytics={live.analytics} />}
        {view === "model" && <ModelView updatedLabel={updatedLabel} stationCount={stations.length} source={live.source} lastClientRefresh={lastClientRefresh} snapshot={live.snapshot} analytics={snapshotAnalytics} tripData={tripAnalytics} />}
      </div>

      <nav className="mobile-tabs" aria-label="手机端主导航">
        {nav.map((item) => <button data-testid={`mobile-nav-${item.id}`} key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)} aria-current={view === item.id ? "page" : undefined}><item.icon size={18} /><span>{item.label.replace("实时", "").replace("站点", "")}</span></button>)}
      </nav>
    </section>
  </main>;
}

function OverviewView({ stations, totals, riskStations, tasks, selectedId, onSelect, onOpenTask, temperature, wind, navigate, analytics, snapshot }: {
  stations: DerivedStation[];
  totals: { bikes: number; docks: number; ebikes: number; disabled: number; online: number };
  riskStations: DerivedStation[];
  tasks: RebalanceTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
  temperature: string;
  wind: string;
  navigate: (view: ViewKey) => void;
  analytics?: LiveAnalytics;
  snapshot?: LivePayload["snapshot"];
}) {
  const operationalCount = analytics?.totals.operationalStations ?? stations.filter((station) => station.actionable).length;
  const serviceRate = stations.length ? operationalCount / stations.length : 0;
  const electricRate = totals.bikes ? totals.ebikes / totals.bikes : 0;
  const selected = stations.find((station) => station.id === selectedId);
  const issueCount = stations.filter((station) => !station.actionable).length;
  return <section className="overview-view">
    <div className="command-strip">
      <div className="command-copy"><span><Sparkles size={13} /> 当前运营判断</span><h2>{riskStations.length ? `${riskStations.length} 个站点触发库存阈值，建议人工复核` : "当前网络供需平稳"}</h2><p>站点库存、服务状态与天气为实时数据；风险来自容量阈值规则，不是模型预测。页面在线时每5分钟写入一轮持久化快照。</p></div>
      <div className="command-stats"><div><strong>{riskStations.filter((s) => s.riskType === "shortage").length}</strong><span>缺车风险</span></div><div><strong>{riskStations.filter((s) => s.riskType === "overflow").length}</strong><span>满桩风险</span></div><div><strong>{tasks.reduce((sum, task) => sum + task.amount, 0)}</strong><span>建议调度车辆</span></div></div>
      <button onClick={() => navigate("dispatch")}>打开调度台 <ChevronRight size={15} /></button>
    </div>

    <div className="kpi-grid kpi-grid-six">
      <Kpi icon={Layers3} label="可运营站点" value={number.format(analytics?.totals.operationalStations ?? totals.online)} note={`服务可用率 ${pct(serviceRate)}`} tone="violet" />
      <Kpi icon={Bike} label="可用车辆" value={number.format(totals.bikes)} note="全网当前库存" tone="blue" />
      <Kpi icon={CircleDot} label="可用车位" value={number.format(totals.docks)} note="预计还车容量" tone="teal" />
      <Kpi icon={Zap} label="电助力车" value={pct(electricRate)} note={`${number.format(totals.ebikes)} 辆可用`} tone="amber" />
      <Kpi icon={AlertTriangle} label="服务异常站点" value={number.format(issueCount)} note="含停运、陈旧与容量异常" tone="coral" />
      <Kpi icon={CloudSun} label="纽约天气" value={`${temperature}°C`} note={`风速 ${wind} km/h`} tone="sky" />
    </div>

    <div className="overview-main-grid">
      <article className="card map-card">
        <CardHead eyebrow="实时库存地图" title="当前站点库存风险" note="点击右侧站点后，地图会定位并用黑色圆环突出" />
        <div className="map-wrap"><BikeMap stations={stations} selectedId={selectedId} onSelect={onSelect} />
          <div className="map-legend"><span><i className="shortage" />缺车</span><span><i className="overflow" />满桩</span><span><i className="balanced" />平衡</span><span><i className="unavailable" />服务异常</span></div>
          {selected && <div className={`station-pop ${selected.actionable ? "" : "station-unavailable"}`} data-testid="selected-station-detail"><span><MapPin size={11} /> 地图已定位 · {selected.actionable ? selected.riskType === "shortage" ? "缺车风险" : selected.riskType === "overflow" ? "满桩风险" : "供需平衡" : serviceStateLabel(selected)}</span><b>{selected.name}</b><small className="station-id">站点 {selected.id}</small><div className="station-pop-metrics"><p><strong>{selected.bikes}</strong><small>可用车</small></p><p><strong>{selected.docks}</strong><small>空车位</small></p><p><strong>{selected.capacity || "—"}</strong><small>容量</small></p><p><strong>{selected.ebikes}</strong><small>电助力车</small></p><p><strong>{selected.disabled}</strong><small>故障车</small></p><p><strong>{selected.actionable ? selected.risk : "—"}</strong><small>风险分</small></p></div><footer><span>库存率 {selected.actionable ? pct(selected.ratio) : "不可计算"}</span><span>{serviceStateLabel(selected)}</span><span>{selected.lastReported > 100000 ? `${new Date(selected.lastReported * 1000).toLocaleTimeString("zh-CN", { hour12: false })} 上报` : "无有效上报"}</span></footer></div>}
        </div>
      </article>

      <article className="card attention-card">
        <CardHead eyebrow="需要立即关注" title="高风险站点" note="点击任一行，在左侧地图定位" action={<button className="icon-button" onClick={() => navigate("forecast")} aria-label="打开站点诊断"><SlidersHorizontal size={15} /></button>} />
        <div className="risk-list">{riskStations.slice(0, 8).map((station, index) => <button key={station.id} className={selectedId === station.id ? "selected" : ""} onClick={() => onSelect(station.id)}><em>{String(index + 1).padStart(2, "0")}</em><span><b>{station.name}</b><small>{station.riskType === "shortage" ? `仅 ${station.bikes} 辆可借` : `仅 ${station.docks} 个空位`}</small></span><i className={station.riskType} /><strong>{station.risk}</strong></button>)}</div>
        <button className="full-link" onClick={() => navigate("forecast")}>查看全部风险站点 <ChevronRight size={14} /></button>
      </article>
    </div>

    <div className="overview-bottom-grid">
      <article className="card task-preview"><CardHead eyebrow="待复核调度" title="点击查看配对详情" note="按当前库存与直线距离生成" /><div className="task-preview-list">{tasks.slice(0, 3).map((task) => <button data-testid={`overview-task-${task.id}`} key={task.id} onClick={() => onOpenTask(task.id)}><span className={`priority ${task.priority === "紧急" ? "urgent" : ""}`}>{task.priority}</span><div><b>{task.source}</b><small>调往 {task.target}</small></div><strong>{task.amount} 辆</strong><em>{task.distanceKm}km</em><ChevronRight size={13} /></button>)}</div></article>
      <article className="card live-region-card"><CardHead eyebrow="区域供给热度" title="实时车辆分布" note="坐标规则近似分区 · 按可用车排序" /><div>{(analytics?.regions ?? []).slice(0, 4).map((region) => <p key={region.name}><span><b>{region.name}</b><small>{region.stations} 个站点 · 空站 {region.emptyStations}</small></span><i><u style={{ width: `${Math.max(8, region.bikeShare * 100)}%` }} /></i><strong>{number.format(region.bikes)}</strong></p>)}</div></article>
      <article className="card freshness-card"><span>MEASURED FRESHNESS</span><div><TimerReset size={18} /><strong>{analytics ? `${analytics.freshness.sourceAgeSeconds}s` : "—"}</strong></div><p>实际源延迟 · 陈旧站点 {analytics?.freshness.staleStations ?? "—"} 个</p><div className={`snapshot-state ${snapshot?.persisted ? "ok" : "warn"}`}><i />{snapshot?.persisted ? "5分钟快照已写入 D1" : "快照存储未生效"}</div></article>
    </div>
  </section>;
}

function ForecastView({ stations, riskStations, selected, setSelectedId, stationHistory, query, setQuery }: {
  stations: DerivedStation[];
  riskStations: DerivedStation[];
  selected?: DerivedStation;
  setSelectedId: (id: string) => void;
  stationHistory: StationSnapshot[];
  query: string;
  setQuery: (value: string) => void;
}) {
  const filtered = riskStations.filter((station) => station.name.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  const historyRows = stationHistory.slice(-13);
  const hasHistory = historyRows.length >= 2;
  const warningLine = selected?.actionable ? Math.max(3, Math.round(selected.capacity * .12)) : 0;
  const historyOption = {
    grid: { left: 48, right: 24, top: 44, bottom: 42 },
    tooltip: { trigger: "axis", backgroundColor: "rgba(25,31,60,.94)", borderWidth: 0, textStyle: { color: "#fff", fontSize: 11 } },
    legend: { top: 4, right: 18, itemWidth: 12, textStyle: { color: "#758097", fontSize: 10 } },
    xAxis: { type: "category", data: historyRows.map((row) => new Date(row.snapshot_at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })), axisLine: { lineStyle: { color: "#e5e8f1" } }, axisTick: { show: false }, axisLabel: { color: "#8f99ad", fontSize: 10 } },
    yAxis: { type: "value", max: selected?.capacity || undefined, name: "辆 / 车位", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#8f99ad", fontSize: 10 } },
    series: [
      { name: "可用车辆", type: "line", data: historyRows.map((row) => row.bikes), smooth: .22, symbolSize: 6, lineStyle: { width: 3, color: "#5c51e3" }, itemStyle: { color: "#5c51e3" }, markLine: { silent: true, symbol: "none", data: [{ yAxis: warningLine, name: "缺车阈值" }], lineStyle: { color: "#e76f5d", type: "dashed" }, label: { formatter: "缺车阈值", color: "#b85a4c", fontSize: 9 } } },
      { name: "可用车位", type: "line", data: historyRows.map((row) => row.docks), smooth: .22, symbolSize: 6, lineStyle: { width: 2, color: "#159783" }, itemStyle: { color: "#159783" } },
    ],
  };
  const operationalStations = stations.filter((station) => station.actionable);
  const distribution = {
    grid: { left: 42, right: 18, top: 28, bottom: 34 },
    xAxis: { type: "category", data: ["0–20", "20–40", "40–60", "60–80", "80–100"], axisLabel: { color: "#8d97aa", fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: "value", name: "站点数", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#9ba4b6", fontSize: 10 } },
    series: [{ type: "bar", data: [operationalStations.filter(s => s.risk < 20).length, operationalStations.filter(s => s.risk >= 20 && s.risk < 40).length, operationalStations.filter(s => s.risk >= 40 && s.risk < 60).length, operationalStations.filter(s => s.risk >= 60 && s.risk < 80).length, operationalStations.filter(s => s.risk >= 80).length], barWidth: "56%", itemStyle: { color: "#675cf0", borderRadius: [7, 7, 0, 0] } }],
  };
  return <section className="forecast-view">
    <div className="section-toolbar diagnostic-toolbar"><div><Check size={15} /><span>只展示真实快照；没有模型时不再绘制未来曲线</span></div><div className="baseline-badge"><Database size={13} /> 当前站点已积累 {historyRows.length} 个快照</div></div>
    <div className="forecast-kpis kpi-grid"><Kpi icon={Bike} label="当前可用车辆" value={String(selected?.bikes ?? "—")} note={`站点容量 ${selected?.capacity || "不可用"}`} tone="blue" /><Kpi icon={CircleDot} label="当前可用车位" value={String(selected?.docks ?? "—")} note={selected?.actionable ? "来自最新 GBFS 状态" : serviceStateLabel(selected)} tone="teal" /><Kpi icon={AlertTriangle} label="当前库存风险分" value={selected?.actionable ? String(selected.risk) : "不计算"} note={selected?.riskType === "shortage" ? "当前低库存" : selected?.riskType === "overflow" ? "当前低空位" : serviceStateLabel(selected)} tone="coral" /><Kpi icon={Gauge} label="告警库存线" value={selected?.actionable ? String(warningLine) : "—"} note="低于容量 12% 触发" tone="violet" /></div>
    <div className="forecast-grid">
      <article className="card forecast-chart"><CardHead eyebrow="真实库存轨迹" title={selected?.name ?? "请选择站点"} note="最近快照中的可用车辆与空车位" />{hasHistory ? <ReactECharts option={historyOption} style={{ height: 355 }} /> : <div className="diagnostic-empty"><Database size={28} /><b>该站点尚无足够历史快照</b><p>当前值已经显示；至少积累两个5分钟快照后才绘制趋势，不再用重复直线冒充分析。</p></div>}</article>
      <article className="card station-browser"><div className="station-browser-head"><CardHead eyebrow="站点排行" title="可运营风险站点" note={`${riskStations.length} 个需要关注`} /><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点" /></label></div><div className="station-table"><div className="station-row head"><span>站点</span><span>车辆</span><span>车位</span><span>风险</span></div>{filtered.map((station) => <button key={station.id} className={selected?.id === station.id ? "selected" : ""} onClick={() => setSelectedId(station.id)}><span><b>{station.name}</b><small>{station.riskType === "shortage" ? "缺车" : "满桩"} · {serviceStateLabel(station)}</small></span><strong>{station.bikes}</strong><strong>{station.docks}</strong><em>{station.risk}</em></button>)}</div></article>
      <article className="card risk-distribution"><CardHead eyebrow="全网分布" title="可运营站点风险评分" note="停运、陈旧和容量异常站点已排除" /><ReactECharts option={distribution} style={{ height: 245 }} /></article>
      <article className="card explain-card"><div className="explain-title"><span><Sparkles size={16} /></span><div><small>MEASURED FACTORS</small><h3>当前告警依据</h3></div></div><div className="reason-list"><div><i style={{ width: `${Math.max(5, 100 - ((selected?.bikes ?? 0) / Math.max(1, selected?.capacity ?? 1)) * 100)}%` }} /><span>缺车压力</span><b>{selected?.bikes ?? "—"}</b></div><div><i style={{ width: `${Math.max(5, 100 - ((selected?.docks ?? 0) / Math.max(1, selected?.capacity ?? 1)) * 100)}%` }} /><span>满桩压力</span><b>{selected?.docks ?? "—"}</b></div><div><i style={{ width: `${Math.max(8, ((selected?.bikes ?? 0) / Math.max(1, selected?.capacity ?? 1)) * 100)}%` }} /><span>车辆填充率</span><b>{selected?.actionable ? pct(selected.ratio) : "—"}</b></div><div><i style={{ width: selected?.actionable ? "100%" : "8%" }} /><span>服务状态</span><b>{selected?.actionable ? "正常" : "异常"}</b></div></div><p>风险只使用最新库存、空车位与容量阈值，属于可解释规则告警。未来预测和置信区间必须等模型完成训练、回测并持续优于基线后才会显示。</p></article>
    </div>
  </section>;
}

function DispatchMap({ task, source, target }: { task?: RebalanceTask; source?: DerivedStation; target?: DerivedStation }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const routeGeojson = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: source && target ? [
      { type: "Feature" as const, properties: { kind: "route" }, geometry: { type: "LineString" as const, coordinates: [[source.lon, source.lat], [target.lon, target.lat]] } },
      { type: "Feature" as const, properties: { kind: "source" }, geometry: { type: "Point" as const, coordinates: [source.lon, source.lat] } },
      { type: "Feature" as const, properties: { kind: "target" }, geometry: { type: "Point" as const, coordinates: [target.lon, target.lat] } },
    ] : [],
  }), [source, target]);
  const latestRouteGeojsonRef = useRef(routeGeojson);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [-73.9855, 40.739], zoom: 11.5, attributionControl: false,
      style: basemapStyle(),
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("style.load", () => {
      map.addSource("dispatch-route", { type: "geojson", data: latestRouteGeojsonRef.current });
      map.addLayer({ id: "dispatch-line", type: "line", source: "dispatch-route", filter: ["==", ["get", "kind"], "route"], paint: { "line-color": "#6257e8", "line-width": 4, "line-dasharray": [1.2, 1.2] } });
      map.addLayer({ id: "dispatch-points", type: "circle", source: "dispatch-route", filter: ["!=", ["get", "kind"], "route"], paint: { "circle-radius": 10, "circle-color": ["match", ["get", "kind"], "source", "#526bc1", "#ef6a5b"], "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
    });
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    const resizeMap = () => map.resize();
    window.addEventListener("pageshow", resizeMap);
    window.addEventListener("orientationchange", resizeMap);
    mapRef.current = map;
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("pageshow", resizeMap);
      window.removeEventListener("orientationchange", resizeMap);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    latestRouteGeojsonRef.current = routeGeojson;
    const map = mapRef.current;
    const routeSource = map?.getSource("dispatch-route") as maplibregl.GeoJSONSource | undefined;
    routeSource?.setData(routeGeojson);
    if (map && source && target) {
      const bounds = new maplibregl.LngLatBounds([source.lon, source.lat], [source.lon, source.lat]);
      bounds.extend([target.lon, target.lat]);
      map.fitBounds(bounds, { padding: 55, maxZoom: 14, duration: 550 });
    }
  }, [routeGeojson, source, target, task?.id]);

  return <div ref={containerRef} className="dispatch-map" aria-label={task ? `${task.source} 到 ${task.target} 的调度配对地图` : "调度配对地图"} />;
}

function DispatchView({ tasks, stations, shortageStations, overflowStations, selectedTaskId, setSelectedTaskId }: {
  tasks: RebalanceTask[];
  stations: DerivedStation[];
  shortageStations: DerivedStation[];
  overflowStations: DerivedStation[];
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string) => void;
}) {
  const [taskStatuses, setTaskStatuses] = useState<Record<string, string>>({});
  const totalBikes = tasks.reduce((sum, task) => sum + task.amount, 0);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const source = stations.find((station) => station.id === selectedTask?.sourceId);
  const target = stations.find((station) => station.id === selectedTask?.targetId);
  const sourceAfter = source && selectedTask ? source.bikes - selectedTask.amount : 0;
  const targetAfter = target && selectedTask ? target.bikes + selectedTask.amount : 0;
  const sourceFloor = source ? Math.round(source.capacity * .62) : 0;
  const targetGoal = target ? Math.round(target.capacity * .28) : 0;
  const selectedStatus = selectedTask ? taskStatuses[selectedTask.id] ?? "待复核" : "—";
  return <section className="dispatch-view">
    <div className="dispatch-hero"><div><span><Truck size={15} /> CURRENT INVENTORY PAIRING</span><h2>当前库存调度建议</h2><p>先找低库存目标站，再从满足最低保留库存的站点中选择直线距离最近的调出站。它是可解释的人工复核建议，不是道路最优路线。</p></div><div className="dispatch-impact"><div><span>当前缺车风险站</span><strong>{shortageStations.length}</strong></div><div><span>可复核配对</span><strong>{tasks.length}</strong></div><div><span>建议搬运</span><strong>{totalBikes} 辆</strong></div></div></div>
    <div className="dispatch-grid">
      <article className="card dispatch-table-card"><div className="dispatch-table-head"><CardHead eyebrow="候选队列" title="点击一行查看地图与明细" note="目标站风险优先，同级选择更近调出站" /><button className="soft-button" onClick={() => tasks[0] && setSelectedTaskId(tasks[0].id)}><RefreshCw size={14} />回到最高优先级</button></div><div className="dispatch-table"><div className="dispatch-row head"><span>任务</span><span>调出站</span><span>调入站</span><span>数量</span><span>距离</span><span>优先级</span><span>状态</span></div>{tasks.map((task) => <button data-testid={`dispatch-task-${task.id}`} className={`dispatch-row task-row ${selectedTask?.id === task.id ? "selected" : ""}`} key={task.id} onClick={() => setSelectedTaskId(task.id)}><span><b>{task.id}</b><small>目标风险 {task.risk}</small></span><span>{task.source}</span><span>{task.target}</span><strong>{task.amount} 辆</strong><span>{task.distanceKm} km</span><span><em className={`priority ${task.priority === "紧急" ? "urgent" : ""}`}>{task.priority}</em></span><span><em className={`task-status ${taskStatuses[task.id] === "已批准" ? "approved" : taskStatuses[task.id] === "已驳回" ? "rejected" : ""}`}>{taskStatuses[task.id] ?? "待复核"}</em></span></button>)}</div></article>
      <aside className="dispatch-side">
        <article className="card selected-task-card" data-testid="selected-task-detail"><CardHead eyebrow="选中任务详情" title={selectedTask?.id ?? "暂无任务"} note="点击左侧其他任务可切换" /><div className="dispatch-map-wrap"><DispatchMap task={selectedTask} source={source} target={target} /><div className="dispatch-map-legend"><span><i className="source" />调出站</span><span><i className="target" />调入站</span></div></div><div className="task-detail-stations"><div><span>调出站 · 搬出后仍保留 {sourceFloor} 辆以上</span><b>{source?.name ?? "—"}</b><p><strong>{source?.bikes ?? 0}</strong> → <em>{sourceAfter}</em> 辆 · 容量 {source?.capacity ?? 0}</p></div><div><span>调入站 · 目标恢复到约 {targetGoal} 辆</span><b>{target?.name ?? "—"}</b><p><strong>{target?.bikes ?? 0}</strong> → <em>{targetAfter}</em> 辆 · 容量 {target?.capacity ?? 0}</p></div></div><div className="task-detail-metrics"><p><span>建议搬运</span><b>{selectedTask?.amount ?? 0} 辆</b></p><p><span>直线距离</span><b>{selectedTask?.distanceKm ?? 0} km</b></p><p><span>目标风险分</span><b>{selectedTask?.risk ?? 0}</b></p></div><p className="task-rule-note"><CircleDot size={13} /> 生成依据：目标站低于 28% 补车目标；调出站搬车后不低于 62% 库存线。距离为坐标直线距离，执行前仍需检查道路、车辆与班组能力。</p><div className="task-actions"><span>当前：{selectedStatus}<small>状态仅保存在本页</small></span><button className="reject" onClick={() => selectedTask && setTaskStatuses((current) => ({ ...current, [selectedTask.id]: "已驳回" }))}>驳回</button><button className="approve" onClick={() => selectedTask && setTaskStatuses((current) => ({ ...current, [selectedTask.id]: "已批准" }))}>批准建议</button></div></article>
        <article className="card capacity-card"><CardHead eyebrow="供给池" title="可调出站点" note={`${overflowStations.length} 个富余站`} /><div>{overflowStations.slice(0, 5).map((station) => <p key={station.id}><span>{station.name}</span><b>{Math.max(0, station.bikes - Math.round(station.capacity * .62))} 辆可调</b></p>)}</div></article>
      </aside>
    </div>
  </section>;
}

function HistoryView({ data, liveAnalytics }: { data: TripAnalytics | null; liveAnalytics?: LiveAnalytics }) {
  if (!data) return <section className="history-view"><div className="history-note"><Database size={17} /><div><b>正在读取月度骑行分析</b><span>真实聚合数据加载中</span></div></div></section>;
  const member = data.users.find((row) => row.type === "member");
  const casual = data.users.find((row) => row.type === "casual");
  const electric = data.bikes.find((row) => row.type.includes("electric"));
  const dominantDistance = data.distanceBands.reduce((best, row) => row.member + row.casual > best.member + best.casual ? row : best, data.distanceBands[0]);
  const rainEffect = data.weather?.controlledEffects.find((row) => row.factor.includes("降雨"))?.effectPct ?? 0;
  const hourlyOption = {
    grid: { left: 48, right: 18, top: 34, bottom: 30 }, tooltip: { trigger: "axis" }, legend: { top: 0, right: 10, textStyle: { fontSize: 10, color: "#7d879a" } },
    xAxis: { type: "category", data: data.hourly.map((row) => row.label), axisLabel: { interval: 2, color: "#929bad", fontSize: 9 }, axisLine: { lineStyle: { color: "#e6e9f1" } }, axisTick: { show: false } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 9, formatter: (value: number) => `${Math.round(value / 1000)}k` } },
    series: [{ name: "会员", type: "line", data: data.hourly.map((row) => row.member), smooth: .35, showSymbol: false, lineStyle: { width: 3, color: "#6257e8" }, areaStyle: { color: "rgba(98,87,232,.11)" } }, { name: "临时用户", type: "line", data: data.hourly.map((row) => row.casual), smooth: .35, showSymbol: false, lineStyle: { width: 2, color: "#19a895" } }],
  };
  const weekdayOption = {
    grid: { left: 54, right: 18, top: 42, bottom: 38 }, tooltip: { trigger: "axis" }, legend: { top: 4, right: 12, textStyle: { fontSize: 10, color: "#7d879a" } },
    xAxis: { type: "category", data: data.weekday.map((row) => row.label), axisLabel: { color: "#8d97aa", fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: "value", name: "骑行量", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 9, formatter: (value: number) => `${Math.round(value / 1000)}k` } },
    series: [{ name: "会员", type: "bar", stack: "rides", data: data.weekday.map((row) => row.member), itemStyle: { color: "#6257e8" } }, { name: "临时用户", type: "bar", stack: "rides", data: data.weekday.map((row) => row.casual), itemStyle: { color: "#22a893", borderRadius: [5, 5, 0, 0] } }],
  };
  const regionOption = {
    grid: { left: 88, right: 28, top: 20, bottom: 25 }, tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 9, formatter: (value: number) => `${Math.round(value / 1000)}k` } },
    yAxis: { type: "category", inverse: true, data: data.regions.slice(0, 8).map((row) => row.name), axisLabel: { color: "#68748a", fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{ type: "bar", data: data.regions.slice(0, 8).map((row) => row.starts), barWidth: 13, itemStyle: { color: "#6257e8", borderRadius: [0, 7, 7, 0] } }],
  };
  const durationOption = {
    grid: { left: 44, right: 16, top: 28, bottom: 42 }, tooltip: { trigger: "axis" }, legend: { top: 0, right: 8, textStyle: { fontSize: 9 } },
    xAxis: { type: "category", data: data.durationBands.map((row) => row.label), axisLabel: { color: "#8d97aa", fontSize: 8 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 8, formatter: (value: number) => `${Math.round(value / 1000)}k` } },
    series: [{ name: "会员", type: "bar", stack: "rides", data: data.durationBands.map((row) => row.member), itemStyle: { color: "#6257e8" } }, { name: "临时用户", type: "bar", stack: "rides", data: data.durationBands.map((row) => row.casual), itemStyle: { color: "#22a893", borderRadius: [5, 5, 0, 0] } }],
  };
  const distanceOption = {
    grid: { left: 55, right: 55, top: 62, bottom: 38 }, tooltip: { trigger: "axis" }, legend: { top: 10, left: "center", itemWidth: 16, itemHeight: 8, textStyle: { fontSize: 9 } },
    xAxis: { type: "category", data: data.distanceBands.map((row) => row.label), axisLabel: { color: "#8d97aa", fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: [{ type: "value", name: "骑行量", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 8, formatter: (value: number) => `${Math.round(value / 1000)}k` } }, { type: "value", name: "分钟", splitLine: { show: false }, axisLabel: { color: "#929bad", fontSize: 8 } }],
    series: [{ name: "会员", type: "bar", stack: "rides", data: data.distanceBands.map((row) => row.member), itemStyle: { color: "#6257e8" } }, { name: "临时用户", type: "bar", stack: "rides", data: data.distanceBands.map((row) => row.casual), itemStyle: { color: "#22a893", borderRadius: [5, 5, 0, 0] } }, { name: "平均时长", type: "line", yAxisIndex: 1, data: data.distanceBands.map((row) => row.avgDuration), smooth: true, symbolSize: 6, lineStyle: { width: 2, color: "#ee8b45" }, itemStyle: { color: "#ee8b45" } }],
  };
  const weatherOption = data.weather ? {
    grid: { left: 52, right: 18, top: 42, bottom: 38 }, tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: data.weather.rainImpact.map((row) => row.label), axisLabel: { color: "#8d97aa", fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: "value", min: 50, name: "需求指数", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 8 } },
    series: [{ type: "bar", data: data.weather.rainImpact.map((row) => ({ value: row.demandIndex, itemStyle: { color: row.label === "无降雨" ? "#6257e8" : row.label === "小雨" ? "#72a9df" : "#9aa4b8", borderRadius: [7, 7, 0, 0] } })), barWidth: 34, markLine: { silent: true, symbol: "none", data: [{ yAxis: 100 }], lineStyle: { color: "#ee8b45", type: "dashed" }, label: { formatter: "时段基线 100", color: "#a76b36", fontSize: 8 } } }],
  } : null;
  return <section className="history-view">
    <div className="history-note"><Database size={17} /><div><b>{data.meta.month} Citi Bike 全量骑行明细</b><span>{number.format(data.meta.rawRows)} 条原始记录，清洗后保留 {number.format(data.meta.validRides)} 次有效骑行；口径：{data.meta.filters}</span></div><span className="verified-badge"><Check size={13} />真实数据</span></div>
    <div className="history-kpis kpi-grid"><Kpi icon={Activity} label="有效骑行" value={number.format(data.meta.validRides)} note={`${data.meta.activeDays} 天完整月份`} tone="violet" /><Kpi icon={MapPin} label="活跃站点" value={number.format(data.meta.stations)} note="至少产生一次有效出发" tone="blue" /><Kpi icon={Gauge} label="会员骑行占比" value={pct(member?.share ?? 0)} note={`峰值 ${member?.peakHour ?? "—"}:00`} tone="teal" /><Kpi icon={Zap} label="电助力车占比" value={pct(electric?.share ?? 0)} note={`${number.format(electric?.rides ?? 0)} 次骑行`} tone="amber" /></div>
    <div className="business-grid">
      <article className="card history-hourly"><CardHead eyebrow="用户活跃时段" title="会员与临时用户小时需求" note="按骑行开始时间统计" /><ReactECharts option={hourlyOption} style={{ height: 340 }} /></article>
      <article className="card region-demand"><CardHead eyebrow="区域热度" title="区域骑行出发量" note="按起点坐标规则近似分区，非行政边界" /><ReactECharts option={regionOption} style={{ height: 340 }} /></article>
      <article className="card weekday-analysis"><CardHead eyebrow="工作日 × 周末" title="一周需求与用户结构" note="同时观察总量和临时用户占比" /><ReactECharts option={weekdayOption} style={{ height: 300 }} /></article>
      <article className="card segment-analysis"><CardHead eyebrow="用户结构" title="会员 vs 临时用户" note="无个人ID，仅做群体级分析" /><div className="segment-compare"><div><span>会员</span><strong>{number.format(member?.rides ?? 0)}</strong><p><b>{member?.avgDuration ?? "—"} min</b>平均时长</p><p><b>{pct(member?.weekendShare ?? 0)}</b>周末占比</p><p><b>{pct(member?.electricShare ?? 0)}</b>电助力偏好</p></div><div><span>临时用户</span><strong>{number.format(casual?.rides ?? 0)}</strong><p><b>{casual?.avgDuration ?? "—"} min</b>平均时长</p><p><b>{pct(casual?.weekendShare ?? 0)}</b>周末占比</p><p><b>{pct(casual?.electricShare ?? 0)}</b>电助力偏好</p></div></div></article>
      <article className="card duration-analysis"><CardHead eyebrow="交互偏好代理" title="骑行时长分布" note="以用车行为代替不存在的点击数据" /><ReactECharts option={durationOption} style={{ height: 290 }} /></article>
      <article className="card distance-analysis"><CardHead eyebrow="距离 × 用户 × 时长" title="直线距离与骑行行为" note="基于起终点坐标，非道路里程" /><ReactECharts option={distanceOption} style={{ height: 330 }} /><p className="method-note">样本 {number.format(data.distanceModel.samples)} 次；距离与时长的对数模型 R² {data.distanceModel.r2.toFixed(3)}。直线距离每增加 1%，时长平均关联增加 {data.distanceModel.distanceElasticity.toFixed(2)}%，用于描述而非路线规划。</p></article>
      {data.weather && weatherOption && <article className="card weather-analysis"><CardHead eyebrow="天气 × 小时需求" title="降雨条件下的需求变化" note={`${data.weather.matchedHours} 个小时完整匹配`} /><ReactECharts option={weatherOption} style={{ height: 270 }} /><div className="temperature-strip">{data.weather.temperatureImpact.map((row) => <div key={row.label}><span>{row.label}</span><b>{row.demandIndex}</b><small>{row.hours} 小时</small></div>)}</div><p className="method-note">需求指数已按“星期 × 小时”基线标准化，100 代表相同时段平均水平，减少早晚高峰对天气比较的干扰。</p></article>}
      {data.weather && <article className="card factor-model"><CardHead eyebrow="天气关系分析" title="原始相关与控制后关联" note="正数同向 · 负数反向 · 不等于因果" /><div className="relationship-head"><span>天气因素</span><span>原始相关系数</span><span>控制时段后租车量变化</span></div><div className="relationship-list">{data.weather.controlledEffects.map((row) => { const correlation = data.weather?.correlations.find((item) => item.factor === row.factor)?.correlation ?? 0; return <div key={row.factor}><b>{row.factor}</b><span className={correlation < 0 ? "negative" : "positive"}>{correlation > 0 ? "+" : ""}{correlation.toFixed(3)}</span><strong className={row.effectPct < 0 ? "negative" : "positive"}>{row.effectPct > 0 ? "+" : ""}{row.effectPct.toFixed(2)}%</strong><small>{row.factor.includes("降雨") ? "雨越大，需求越低；三项中关系最强" : row.factor.includes("气温") ? "较暖小时通常有更多骑行" : "控制时段后关系较弱"}</small></div>; })}</div><div className="model-facts"><p><span>有效天气小时</span><b>{data.weather.matchedHours}</b></p><p><span>模型解释度 R²</span><b>{data.weather.controlledModelR2.toFixed(3)}</b></p><p><span>控制变量</span><b>小时 + 星期</b></p></div><p className="method-note">读法示例：降雨 +1mm 与租车量变化 {rainEffect.toFixed(2)}% 相关。模型使用小时骑行量并控制小时、星期；活动、节假日等遗漏变量仍可能影响结果，因此不能当作天气的因果效应。</p></article>}
      <article className="card live-availability"><CardHead eyebrow="实时供给结构" title="当前站点可用性" note="来自最新 GBFS 快照" /><div>{(liveAnalytics?.availability ?? []).map((row) => <p key={row.label}><span>{row.label}</span><i><u style={{ width: `${Math.max(4, row.count / Math.max(1, liveAnalytics?.availability.reduce((sum, item) => sum + item.count, 0) ?? 1) * 100)}%` }} /></i><b>{number.format(row.count)}</b></p>)}</div></article>
      <article className="card route-ranking"><CardHead eyebrow="OD 流向" title="热门起终点组合" note="排除起终点相同的骑行" /><div className="route-ranking-list">{data.topRoutes.slice(0, 8).map((route, index) => <div key={`${route.start}-${route.end}`}><em>{index + 1}</em><span><b>{route.start}</b><small>→ {route.end}</small></span><strong>{number.format(route.rides)}</strong></div>)}</div></article>
      <article className="card region-profile"><CardHead eyebrow="区域多维画像" title="热度、流入流出与偏好" note="坐标规则近似分区 · 同表对比8个区域" /><div className="region-profile-table"><div className="region-profile-row head"><span>区域</span><span>出发</span><span>净流入</span><span>会员</span><span>电助力</span><span>时长</span><span>距离</span><span>峰值</span></div>{data.regions.slice(0, 8).map((region) => <div className="region-profile-row" key={region.name}><b>{region.name}</b><span>{number.format(region.starts)}</span><strong className={region.netFlow < 0 ? "negative" : "positive"}>{region.netFlow > 0 ? "+" : ""}{number.format(region.netFlow)}</strong><span>{pct(region.memberShare)}</span><span>{pct(region.electricShare)}</span><span>{region.avgDuration}m</span><span>{region.avgDistance}km</span><span>{region.peakHour}:00</span></div>)}</div></article>
      <article className="card analysis-conclusions"><CardHead eyebrow="本月可执行发现" title="从图表到运营动作" note="仅适用于 2026 年 4 月样本" /><div><p><span>距离结构</span><b>{dominantDistance.label} 骑行量最高</b><small>短途站点应优先保证高周转库存</small></p><p><span>天气关系</span><b>降雨是三项中最强负向因素</b><small>可试验性下调雨天补车目标并持续验证</small></p><p><span>用户差异</span><b>临时用户时长关联 +{data.distanceModel.casualDurationEffectPct.toFixed(1)}%</b><small>控制距离与车型后仍明显更长</small></p><p><span>车型差异</span><b>电助力车时长关联 {data.distanceModel.electricDurationEffectPct.toFixed(1)}%</b><small>同距离下周转更快，应单独监控供给</small></p></div></article>
    </div>
  </section>;
}

function ModelView({ updatedLabel, stationCount, source, lastClientRefresh, snapshot, analytics, tripData }: {
  updatedLabel: string; stationCount: number; source: "live" | "fallback"; lastClientRefresh: Date | null;
  snapshot?: LivePayload["snapshot"]; analytics: SnapshotAnalytics | null; tripData: TripAnalytics | null;
}) {
  const snapshotCount = analytics?.collection.snapshots ?? 0;
  const baselinePairs = Number(analytics?.baseline.pairs ?? 0);
  const baselineMae = analytics?.baseline.mae_30m;
  return <section className="model-view">
    <div className="model-status"><div className="model-orb"><BrainCircuit size={28} /></div><div><span>CURRENT CAPABILITY</span><h2>当前没有在线预测模型</h2><p>正在运行的是实时采集、D1 快照和真实月度经营分析。库存风险来自当前值阈值；“库存不变对照法”只是把当前库存当作30分钟后的预测，用来检验未来模型是否确实更准。</p></div><div className="readiness factual"><span>已运行能力</span><strong>3 / 6</strong><i><u /></i></div></div>
    <div className="model-kpis kpi-grid"><Kpi icon={Database} label="GBFS 实时源" value={source === "live" ? "运行中" : "回退中"} note={`最近更新 ${updatedLabel}`} tone="teal" /><Kpi icon={TimerReset} label="D1 快照" value={snapshot?.persisted ? "运行中" : "未生效"} note={`${snapshotCount} 个5分钟快照`} tone="blue" /><Kpi icon={Activity} label="历史骑行明细" value={tripData ? number.format(tripData.meta.validRides) : "未加载"} note={tripData ? `${tripData.meta.month} 真实记录` : "—"} tone="violet" /><Kpi icon={BrainCircuit} label="线上模型" value="未上线" note="当前没有未来预测输出" tone="amber" /></div>
    <div className="model-grid factual-model-grid">
      <article className="card model-roadmap"><CardHead eyebrow="IMPLEMENTATION STATUS" title="真实运行状态" note="只标记已经产生数据的能力" /><div className="roadmap-list"><RoadmapStep state={source === "live" ? "done" : "active"} icon={Database} title="GBFS 实时采集" note={`${number.format(stationCount)} 个站点库存与服务状态`} /><RoadmapStep state={snapshot?.persisted ? "done" : "active"} icon={Boxes} title="页面在线时5分钟快照" note={`D1 已保存 ${snapshotCount} 个系统快照；不是后台 Cron`} /><RoadmapStep state={tripData ? "done" : "active"} icon={Activity} title="月度经营分析" note={tripData ? `${number.format(tripData.meta.validRides)} 次真实骑行已聚合` : "数据加载中"} /><RoadmapStep state={baselinePairs >= 10 ? "active" : "next"} icon={Gauge} title="高风险站快照回放" note={baselinePairs ? `${baselinePairs} 对30分钟选择性样本，MAE ${Number(baselineMae ?? 0).toFixed(2)}` : "需至少积累30分钟快照"} /><RoadmapStep state="next" icon={BrainCircuit} title="LightGBM 在线预测" note="未训练、未部署、无正式模型指标" /><RoadmapStep state="next" icon={Route} title="OR-Tools 调度优化" note="未接道路矩阵与车辆约束" /></div></article>
      <article className="card metric-contract"><CardHead eyebrow="PIPELINE CHECK" title="高风险站30分钟回放" note="只验证快照链路，不代表模型效果" /><div className="contract-grid"><div><span>30分钟样本对</span><strong>{number.format(baselinePairs)}</strong><small>只覆盖持续进入高风险快照的站点</small></div><div><span>库存不变 MAE</span><strong>{baselinePairs ? Number(baselineMae ?? 0).toFixed(2) : "待积累"}</strong><small>当前库存直接作为30分钟后对照</small></div><div><span>LightGBM MAE</span><strong>未训练</strong><small>不存在可报告结果</small></div><div><span>预警 Precision / Recall</span><strong>未计算</strong><small>需要真实空站事件标签</small></div></div><div className="contract-callout"><AlertTriangle size={15} /><p>当前样本只保存高风险站点且依赖页面在线，存在明显选择偏差；这个 MAE 不能作为全网模型成绩。正式训练前必须先建立24×7全站采集。</p></div></article>
      <article className="card data-health factual-health"><CardHead eyebrow="DATA EVIDENCE" title="可核验数据资产" note="当前版本" /><div className="evidence-count"><strong>{snapshotCount}</strong><span>实时系统快照</span></div><div className="health-list"><p><span><i className={source === "live" ? "good" : "warn"} />GBFS 当前状态</span><b>{source === "live" ? "实时" : "回退"}</b></p><p><span><i className={snapshot?.persisted ? "good" : "warn"} />D1 持久化</span><b>{snapshot?.persisted ? "已写入" : "未写入"}</b></p><p><span><i className={tripData ? "good" : "warn"} />月度骑行样本</span><b>{tripData ? number.format(tripData.meta.validRides) : "未加载"}</b></p><p><span><i className="warn" />后台定时采集</span><b>未实现</b></p><p><span><i className="warn" />模型服务</span><b>未实现</b></p></div><small className="last-refresh">最近客户端采集：{lastClientRefresh ? lastClientRefresh.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</small></article>
    </div>
  </section>;
}

function RoadmapStep({ state, icon: Icon, title, note }: { state: "done" | "active" | "next"; icon: typeof Database; title: string; note: string }) {
  return <div className={`roadmap-step ${state}`}><span><Icon size={17} /></span><div><b>{title}</b><small>{note}</small></div><em>{state === "done" ? "已完成" : state === "active" ? "进行中" : "待开始"}</em></div>;
}

function CardHead({ eyebrow, title, note, action }: { eyebrow: string; title: string; note: string; action?: React.ReactNode }) {
  return <header className="card-head"><div><span>{eyebrow}</span><h2>{title}</h2></div><div className="card-head-side"><p>{note}</p>{action}</div></header>;
}

function Kpi({ icon: Icon, label, value, note, tone }: { icon: typeof Bike; label: string; value: string; note: string; tone: string }) {
  return <article className={`kpi-card ${tone}`}><div className="kpi-icon"><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>;
}

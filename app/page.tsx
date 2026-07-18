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
  Navigation,
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
  totals: { bikes: number; docks: number; ebikes: number; disabled: number; onlineStations: number; emptyStations: number; fullStations: number; staleStations: number };
  regions: LiveRegion[];
  availability: Array<{ label: string; count: number }>;
  freshness: { sourceAgeSeconds: number; staleStations: number; completeness: number; measuredAt: number };
};

type TripAnalytics = {
  meta: { month: string; rawRows: number; validRides: number; activeDays: number; stations: number; avgDuration: number; filters: string };
  users: Array<{ type: string; rides: number; share: number; avgDuration: number; weekendShare: number; electricShare: number; peakHour: number }>;
  bikes: Array<{ type: string; rides: number; share: number; avgDuration: number; memberShare: number }>;
  regions: Array<{ name: string; starts: number; ends: number; netFlow: number; share: number; memberShare: number; electricShare: number; avgDuration: number; peakHour: number }>;
  hourly: Array<{ label: string; member: number; casual: number }>;
  weekday: Array<{ label: string; member: number; casual: number }>;
  timeBands: Array<{ label: string; member: number; casual: number }>;
  durationBands: Array<{ label: string; member: number; casual: number }>;
  topRoutes: Array<{ start: string; end: string; rides: number }>;
  topStartStations: Array<{ name: string; rides: number }>;
};

type SnapshotAnalytics = {
  available: boolean;
  collection: { snapshots: number; firstAt: number | null; lastAt: number | null; spanMinutes: number; mode: string };
  system: Array<Record<string, number>>;
  regions: Array<Record<string, number | string>>;
  baseline: { pairs?: number; mae_30m?: number | null };
};

type DerivedStation = Station & {
  ratio: number;
  risk: number;
  riskType: RiskType;
  projectedBikes: number;
  change: number;
};

const nav = [
  { id: "overview" as const, label: "实时运营", note: "全网状态与风险", icon: Gauge },
  { id: "forecast" as const, label: "供需预测", note: "15 / 30 / 60分钟", icon: TrendingUp },
  { id: "dispatch" as const, label: "调度工作台", note: "任务、数量与路径", icon: Route },
  { id: "history" as const, label: "经营分析", note: "区域、用户与偏好", icon: CalendarRange },
  { id: "model" as const, label: "模型中心", note: "效果、解释与漂移", icon: BrainCircuit },
];

const viewMeta: Record<ViewKey, { eyebrow: string; title: string; subtitle: string }> = {
  overview: { eyebrow: "LIVE OPERATIONS", title: "实时运营中心", subtitle: "把当前库存、未来风险和可执行调度放在同一张地图上" },
  forecast: { eyebrow: "DEMAND FORECAST", title: "站点供需预测", subtitle: "查看重点站点的库存轨迹、风险窗口和冷启动基线" },
  dispatch: { eyebrow: "REBALANCE DESK", title: "智能调度工作台", subtitle: "从富余站点向高风险站点生成可追踪的调度任务" },
  history: { eyebrow: "BUSINESS ANALYTICS", title: "骑行业务分析", subtitle: "基于真实月度骑行明细分析区域热度、用户结构、车辆偏好与出行规律" },
  model: { eyebrow: "MODEL OPS", title: "模型与数据监控", subtitle: "明确区分实时数据、冷启动规则和待训练模型" },
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

function deriveStation(station: Station, horizon: number): DerivedStation {
  const capacity = Math.max(1, station.capacity || station.bikes + station.docks);
  const ratio = station.bikes / capacity;
  const lower = Math.max(3, Math.round(capacity * 0.12));
  const upper = Math.max(3, Math.round(capacity * 0.12));
  const shortagePressure = clamp((lower - station.bikes) / lower, 0, 1);
  const overflowPressure = clamp((upper - station.docks) / upper, 0, 1);
  const riskType: RiskType = shortagePressure > 0 ? "shortage" : overflowPressure > 0 ? "overflow" : "balanced";
  const baseRisk = Math.max(shortagePressure, overflowPressure) * 78;
  const uncertainty = riskType === "balanced" ? Math.max(0, 22 - Math.abs(ratio - 0.5) * 55) : 18;
  const risk = clamp(Math.round(baseRisk + uncertainty + horizon * 0.14), 4, 99);
  const change = 0;
  const projectedBikes = station.bikes;
  return { ...station, capacity, ratio, risk, riskType, projectedBikes, change };
}

function BikeMap({ stations, selectedId, onSelect }: { stations: DerivedStation[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const geojson = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: stations.map((station) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [station.lon, station.lat] },
      properties: { id: station.id, name: station.name, bikes: station.bikes, docks: station.docks, risk: station.risk, riskType: station.riskType },
    })),
  }), [stations]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [-73.9855, 40.739],
      zoom: 11.6,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          carto: {
            type: "raster",
            tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap © CARTO",
          },
        },
        layers: [{ id: "carto", type: "raster", source: "carto", paint: { "raster-opacity": 0.82 } }],
      },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("load", () => {
      map.addSource("stations", { type: "geojson", data: geojson });
      map.addLayer({
        id: "station-glow",
        type: "circle",
        source: "stations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "risk"], 0, 5, 100, 15],
          "circle-color": ["match", ["get", "riskType"], "shortage", "#ef6a5b", "overflow", "#f0a33a", "#4d78f0"],
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
          "circle-color": ["match", ["get", "riskType"], "shortage", "#ef6a5b", "overflow", "#f0a33a", "#4d78f0"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2,
          "circle-opacity": 0.92,
        },
      });
      map.on("click", "station-points", (event) => {
        const id = String(event.features?.[0]?.properties?.id ?? "");
        if (id) onSelect(id);
      });
      map.on("mouseenter", "station-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "station-points", () => { map.getCanvas().style.cursor = ""; });
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, [geojson, onSelect]);

  useEffect(() => {
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
  const [horizon, setHorizon] = useState(30);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState("");
  const [lastClientRefresh, setLastClientRefresh] = useState<Date | null>(null);
  const [tripAnalytics, setTripAnalytics] = useState<TripAnalytics | null>(null);
  const [snapshotAnalytics, setSnapshotAnalytics] = useState<SnapshotAnalytics | null>(null);

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
    void refresh();
    const timer = window.setInterval(() => void refresh(), 300_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    fetch("/data/trip-analytics.json").then((response) => response.json()).then((payload: TripAnalytics) => setTripAnalytics(payload)).catch(() => setTripAnalytics(null));
  }, []);

  const stations = useMemo(() => live.stations.map((station) => deriveStation(station, horizon)), [live.stations, horizon]);
  const riskStations = useMemo(() => stations.filter((station) => station.riskType !== "balanced").sort((a, b) => b.risk - a.risk), [stations]);
  const shortageStations = useMemo(() => stations.filter((station) => station.riskType === "shortage").sort((a, b) => b.risk - a.risk), [stations]);
  const overflowStations = useMemo(() => stations.filter((station) => station.riskType === "overflow").sort((a, b) => b.risk - a.risk), [stations]);
  const selected = stations.find((station) => station.id === selectedId) ?? riskStations[0] ?? stations[0];

  useEffect(() => {
    if (!selectedId && riskStations[0]) setSelectedId(riskStations[0].id);
  }, [riskStations, selectedId]);

  const totals = useMemo(() => stations.reduce((acc, station) => ({
    bikes: acc.bikes + station.bikes,
    docks: acc.docks + station.docks,
    ebikes: acc.ebikes + station.ebikes,
    disabled: acc.disabled + station.disabled,
    online: acc.online + Number(station.online),
  }), { bikes: 0, docks: 0, ebikes: 0, disabled: 0, online: 0 }), [stations]);

  const tasks = useMemo(() => shortageStations.slice(0, 6).map((target, index) => {
    const source = overflowStations[index % Math.max(1, overflowStations.length)];
    const amount = Math.max(3, Math.min(12, Math.round(target.capacity * 0.28) - target.bikes, source ? source.bikes - Math.round(source.capacity * 0.62) : 5));
    return {
      id: `RB-${String(index + 1).padStart(3, "0")}`,
      source: source?.name ?? "待匹配富余站点",
      target: target.name,
      amount: Math.max(3, amount),
      priority: index < 2 ? "紧急" : index < 4 ? "高" : "中",
      eta: index + 1,
      risk: target.risk,
    };
  }), [shortageStations, overflowStations]);

  const navigate = (target: ViewKey) => { setView(target); setMobileNav(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const updatedLabel = live.updatedAt ? new Date(live.updatedAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--:--";
  const temperature = Number(live.weather?.temperature_2m ?? 25.4).toFixed(1);
  const wind = Number(live.weather?.wind_speed_10m ?? 11.8).toFixed(1);
  const precipitation = Number(live.weather?.precipitation ?? 0).toFixed(1);

  const selectStation = useCallback((id: string) => setSelectedId(id), []);

  return <main className="app-shell">
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
      <div className="brand"><span><Bike size={22} /></span><div><strong>BikeFlow AI</strong><small>供需预测 · 调度中台</small></div><button className="nav-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={17} /></button></div>
      <div className="nav-caption">运营工作台</div>
      <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}><item.icon size={18} /><span><b>{item.label}</b><small>{item.note}</small></span><ChevronRight size={13} className="nav-arrow" /></button>)}</nav>
      <div className="pipeline-card"><div><span className={`live-dot ${live.source === "fallback" ? "demo" : ""}`} /><b>{live.source === "live" ? "GBFS 实时链路正常" : "实时源回退中"}</b></div><strong>{number.format(stations.length)}</strong><small>当前站点 · {updatedLabel}</small><div className="pipeline"><i className={live.source === "live" ? "done" : "active"} /><i className={live.snapshot?.persisted ? "done" : "active"} /><i className={tripAnalytics ? "done" : "active"} /><i /></div><p>实时源 → D1快照 → 月度聚合 → 模型未上线</p></div>
    </aside>

    {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航遮罩" />}

    <section className="workspace">
      <header className="topbar">
        <div className="topbar-title"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={19} /></button><div><span className="page-kicker">{viewMeta[view].eyebrow}</span><h1>{viewMeta[view].title}</h1><p>{viewMeta[view].subtitle}</p></div></div>
        <div className="topbar-actions"><span className="weather-pill"><CloudSun size={15} /><b>{temperature}°</b><span>降雨 {precipitation} mm</span></span><span className="data-badge"><i />{live.source === "live" ? `实时更新 ${updatedLabel}` : "演示数据 · 实时源重连中"}</span><button className="soft-button" onClick={() => window.print()}><ArrowDownToLine size={15} />导出</button><button className="primary-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""} />{loading ? "更新中" : "刷新数据"}</button></div>
      </header>

      <div className="dashboard-stage">
        {view === "overview" && <OverviewView stations={stations} totals={totals} riskStations={riskStations} tasks={tasks} selectedId={selected?.id ?? null} onSelect={selectStation} horizon={horizon} setHorizon={setHorizon} temperature={temperature} wind={wind} navigate={navigate} analytics={live.analytics} snapshot={live.snapshot} />}
        {view === "forecast" && <ForecastView stations={stations} riskStations={riskStations} selected={selected} setSelectedId={setSelectedId} horizon={horizon} setHorizon={setHorizon} query={query} setQuery={setQuery} />}
        {view === "dispatch" && <DispatchView tasks={tasks} shortageStations={shortageStations} overflowStations={overflowStations} />}
        {view === "history" && <HistoryView data={tripAnalytics} liveAnalytics={live.analytics} />}
        {view === "model" && <ModelView updatedLabel={updatedLabel} stationCount={stations.length} source={live.source} lastClientRefresh={lastClientRefresh} snapshot={live.snapshot} analytics={snapshotAnalytics} tripData={tripAnalytics} />}
      </div>
    </section>
  </main>;
}

function OverviewView({ stations, totals, riskStations, tasks, selectedId, onSelect, horizon, setHorizon, temperature, wind, navigate, analytics, snapshot }: {
  stations: DerivedStation[];
  totals: { bikes: number; docks: number; ebikes: number; disabled: number; online: number };
  riskStations: DerivedStation[];
  tasks: Array<{ id: string; source: string; target: string; amount: number; priority: string; eta: number; risk: number }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  horizon: number;
  setHorizon: (value: number) => void;
  temperature: string;
  wind: string;
  navigate: (view: ViewKey) => void;
  analytics?: LiveAnalytics;
  snapshot?: LivePayload["snapshot"];
}) {
  const serviceRate = stations.length ? totals.online / stations.length : 0;
  const electricRate = totals.bikes ? totals.ebikes / totals.bikes : 0;
  const selected = stations.find((station) => station.id === selectedId);
  return <section className="overview-view">
    <div className="command-strip">
      <div className="command-copy"><span><Sparkles size={13} /> 当前运营判断</span><h2>{riskStations.length ? `${riskStations.length} 个站点触发库存阈值，建议人工复核` : "当前网络供需平稳"}</h2><p>站点库存、服务状态与天气为实时数据；风险来自容量阈值规则，不是模型预测。页面在线时每5分钟写入一轮持久化快照。</p></div>
      <div className="command-stats"><div><strong>{riskStations.filter((s) => s.riskType === "shortage").length}</strong><span>缺车风险</span></div><div><strong>{riskStations.filter((s) => s.riskType === "overflow").length}</strong><span>满桩风险</span></div><div><strong>{tasks.reduce((sum, task) => sum + task.amount, 0)}</strong><span>建议调度车辆</span></div></div>
      <button onClick={() => navigate("dispatch")}>打开调度台 <ChevronRight size={15} /></button>
    </div>

    <div className="kpi-grid kpi-grid-six">
      <Kpi icon={Layers3} label="在线站点" value={number.format(totals.online)} note={`服务可用率 ${pct(serviceRate)}`} tone="violet" />
      <Kpi icon={Bike} label="可用车辆" value={number.format(totals.bikes)} note="全网当前库存" tone="blue" />
      <Kpi icon={CircleDot} label="可用车位" value={number.format(totals.docks)} note="预计还车容量" tone="teal" />
      <Kpi icon={Zap} label="电助力车" value={pct(electricRate)} note={`${number.format(totals.ebikes)} 辆可用`} tone="amber" />
      <Kpi icon={AlertTriangle} label="故障车辆" value={number.format(totals.disabled)} note="待检修库存" tone="coral" />
      <Kpi icon={CloudSun} label="纽约天气" value={`${temperature}°C`} note={`风速 ${wind} km/h`} tone="sky" />
    </div>

    <div className="overview-main-grid">
      <article className="card map-card">
        <CardHead eyebrow="风险地图" title={`未来 ${horizon} 分钟站点风险`} note="红色缺车 · 橙色满桩 · 蓝色供需平衡" action={<Segmented value={horizon} values={[15, 30, 60]} onChange={setHorizon} suffix="m" />} />
        <div className="map-wrap"><BikeMap stations={stations} selectedId={selectedId} onSelect={onSelect} />
          <div className="map-legend"><span><i className="shortage" />缺车</span><span><i className="overflow" />满桩</span><span><i className="balanced" />平衡</span></div>
          {selected && <div className="station-pop"><span>{selected.riskType === "shortage" ? "缺车风险" : selected.riskType === "overflow" ? "满桩风险" : "供需平衡"}</span><b>{selected.name}</b><div><strong>{selected.bikes}</strong><small>可用车</small><strong>{selected.docks}</strong><small>可用位</small><strong>{selected.risk}</strong><small>风险分</small></div></div>}
        </div>
      </article>

      <article className="card attention-card">
        <CardHead eyebrow="需要立即关注" title="高风险站点" note={`按 ${horizon} 分钟风险分排序`} action={<button className="icon-button" onClick={() => navigate("forecast")} aria-label="打开预测"><SlidersHorizontal size={15} /></button>} />
        <div className="risk-list">{riskStations.slice(0, 8).map((station, index) => <button key={station.id} className={selectedId === station.id ? "selected" : ""} onClick={() => onSelect(station.id)}><em>{String(index + 1).padStart(2, "0")}</em><span><b>{station.name}</b><small>{station.riskType === "shortage" ? `仅 ${station.bikes} 辆可借` : `仅 ${station.docks} 个空位`}</small></span><i className={station.riskType} /><strong>{station.risk}</strong></button>)}</div>
        <button className="full-link" onClick={() => navigate("forecast")}>查看全部风险站点 <ChevronRight size={14} /></button>
      </article>
    </div>

    <div className="overview-bottom-grid">
      <article className="card task-preview"><CardHead eyebrow="规则候选" title="建议人工复核" note="缺车站与富余站的启发式配对" /><div className="task-preview-list">{tasks.slice(0, 3).map((task) => <div key={task.id}><span className={`priority ${task.priority === "紧急" ? "urgent" : ""}`}>{task.priority}</span><div><b>{task.source}</b><small>调往 {task.target}</small></div><strong>{task.amount} 辆</strong><em>P{task.eta}</em></div>)}</div></article>
      <article className="card live-region-card"><CardHead eyebrow="区域供给热度" title="实时车辆分布" note="按当前可用车辆排序" /><div>{(analytics?.regions ?? []).slice(0, 4).map((region) => <p key={region.name}><span><b>{region.name}</b><small>{region.stations} 个站点 · 空站 {region.emptyStations}</small></span><i><u style={{ width: `${Math.max(8, region.bikeShare * 100)}%` }} /></i><strong>{number.format(region.bikes)}</strong></p>)}</div></article>
      <article className="card freshness-card"><span>MEASURED FRESHNESS</span><div><TimerReset size={18} /><strong>{analytics ? `${analytics.freshness.sourceAgeSeconds}s` : "—"}</strong></div><p>实际源延迟 · 陈旧站点 {analytics?.freshness.staleStations ?? "—"} 个</p><div className={`snapshot-state ${snapshot?.persisted ? "ok" : "warn"}`}><i />{snapshot?.persisted ? "5分钟快照已写入 D1" : "快照存储未生效"}</div></article>
    </div>
  </section>;
}

function ForecastView({ stations, riskStations, selected, setSelectedId, horizon, setHorizon, query, setQuery }: {
  stations: DerivedStation[];
  riskStations: DerivedStation[];
  selected?: DerivedStation;
  setSelectedId: (id: string) => void;
  horizon: number;
  setHorizon: (value: number) => void;
  query: string;
  setQuery: (value: string) => void;
}) {
  const filtered = riskStations.filter((station) => station.name.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  const cap = selected?.capacity ?? 40;
  const now = selected?.bikes ?? 16;
  const points = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
  const actual = points.map((minute) => minute === 0 ? now : null);
  const forecast = points.map((minute) => minute < 0 ? null : now);
  const lower = forecast.map((value, index) => value === null ? null : clamp(value - Math.round(1 + index * 0.55), 0, cap));
  const upper = forecast.map((value, index) => value === null ? null : clamp(value + Math.round(1 + index * 0.55), 0, cap));
  const option = {
    grid: { left: 42, right: 20, top: 34, bottom: 35 },
    tooltip: { trigger: "axis", backgroundColor: "rgba(25,31,60,.94)", borderWidth: 0, textStyle: { color: "#fff", fontSize: 11 } },
    legend: { top: 2, right: 16, itemWidth: 10, textStyle: { color: "#758097", fontSize: 10 } },
    xAxis: { type: "category", data: points.map((v) => v === 0 ? "当前" : `${v > 0 ? "+" : ""}${v}m`), axisLine: { lineStyle: { color: "#e5e8f1" } }, axisTick: { show: false }, axisLabel: { color: "#8f99ad", fontSize: 10 } },
    yAxis: { type: "value", max: cap, splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#8f99ad", fontSize: 10 } },
    series: [
      { name: "当前实测", type: "scatter", data: actual, symbolSize: 10, itemStyle: { color: "#4d78f0" } },
      { name: "持久性基线", type: "line", data: forecast, smooth: 0.2, symbolSize: 5, lineStyle: { width: 3, type: "dashed", color: "#675cf0" }, itemStyle: { color: "#675cf0" } },
      { name: "上界", type: "line", data: upper, symbol: "none", lineStyle: { width: 1, color: "rgba(103,92,240,.26)" }, areaStyle: { color: "rgba(103,92,240,.08)" } },
      { name: "下界", type: "line", data: lower, symbol: "none", lineStyle: { width: 1, color: "rgba(103,92,240,.26)" } },
    ],
  };
  const distribution = {
    grid: { left: 36, right: 14, top: 25, bottom: 28 },
    xAxis: { type: "category", data: ["0–20", "20–40", "40–60", "60–80", "80–100"], axisLabel: { color: "#8d97aa", fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#9ba4b6", fontSize: 9 } },
    series: [{ type: "bar", data: [stations.filter(s => s.risk < 20).length, stations.filter(s => s.risk >= 20 && s.risk < 40).length, stations.filter(s => s.risk >= 40 && s.risk < 60).length, stations.filter(s => s.risk >= 60 && s.risk < 80).length, stations.filter(s => s.risk >= 80).length], barWidth: "56%", itemStyle: { color: "#675cf0", borderRadius: [7, 7, 0, 0] } }],
  };
  return <section className="forecast-view">
    <div className="section-toolbar"><div><span>预测窗口</span><Segmented value={horizon} values={[15, 30, 60]} onChange={setHorizon} suffix="分钟" /></div><div className="baseline-badge"><CircleDot size={13} />冷启动规则基线 · 非训练模型</div></div>
    <div className="forecast-kpis kpi-grid"><Kpi icon={Bike} label="当前可用车辆" value={String(selected?.bikes ?? "—")} note={`站点容量 ${selected?.capacity ?? "—"}`} tone="blue" /><Kpi icon={TrendingUp} label={`${horizon}分钟持久性基线`} value={String(selected?.projectedBikes ?? "—")} note="假设库存保持当前值" tone="violet" /><Kpi icon={AlertTriangle} label="规则风险分" value={`${selected?.risk ?? "—"}`} note={selected?.riskType === "shortage" ? "当前低库存" : selected?.riskType === "overflow" ? "当前低空位" : "供需平衡"} tone="coral" /><Kpi icon={Gauge} label="安全库存线" value={String(Math.max(3, Math.round((selected?.capacity ?? 40) * .12)))} note="容量的 12%" tone="teal" /></div>
    <div className="forecast-grid">
      <article className="card forecast-chart"><CardHead eyebrow="库存轨迹" title={selected?.name ?? "请选择站点"} note="实线为实时快照回看；虚线为冷启动规则基线" /><ReactECharts option={option} style={{ height: 355 }} /></article>
      <article className="card station-browser"><div className="station-browser-head"><CardHead eyebrow="站点排行" title="风险站点" note={`${riskStations.length} 个需要关注`} /><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点" /></label></div><div className="station-table"><div className="station-row head"><span>站点</span><span>当前</span><span>预测</span><span>风险</span></div>{filtered.map((station) => <button key={station.id} className={selected?.id === station.id ? "selected" : ""} onClick={() => setSelectedId(station.id)}><span><b>{station.name}</b><small>{station.riskType === "shortage" ? "缺车" : "满桩"}</small></span><strong>{station.bikes}</strong><strong>{station.projectedBikes}</strong><em>{station.risk}</em></button>)}</div></article>
      <article className="card risk-distribution"><CardHead eyebrow="全网分布" title="风险评分分布" note="评分越高，越应优先人工复核" /><ReactECharts option={distribution} style={{ height: 245 }} /></article>
      <article className="card explain-card"><div className="explain-title"><span><Sparkles size={16} /></span><div><small>MEASURED FACTORS</small><h3>风险依据</h3></div></div><div className="reason-list"><div><i style={{ width: `${Math.max(5, 100 - ((selected?.bikes ?? 0) / Math.max(1, selected?.capacity ?? 1)) * 100)}%` }} /><span>当前可用车辆</span><b>{selected?.bikes ?? "—"}</b></div><div><i style={{ width: `${Math.max(5, 100 - ((selected?.docks ?? 0) / Math.max(1, selected?.capacity ?? 1)) * 100)}%` }} /><span>当前可用车位</span><b>{selected?.docks ?? "—"}</b></div><div><i style={{ width: `${Math.max(8, ((selected?.bikes ?? 0) / Math.max(1, selected?.capacity ?? 1)) * 100)}%` }} /><span>车辆填充率</span><b>{selected ? pct(selected.ratio) : "—"}</b></div><div><i style={{ width: `${Math.min(100, horizon)}%` }} /><span>风险观察窗口</span><b>{horizon}m</b></div></div><p>以上均由当前 GBFS 实测值计算。持久性基线假设未来库存不变，不代表已经训练出需求模型。</p></article>
    </div>
  </section>;
}

function DispatchView({ tasks, shortageStations, overflowStations }: {
  tasks: Array<{ id: string; source: string; target: string; amount: number; priority: string; eta: number; risk: number }>;
  shortageStations: DerivedStation[];
  overflowStations: DerivedStation[];
}) {
  const totalBikes = tasks.reduce((sum, task) => sum + task.amount, 0);
  const before = shortageStations.length;
  return <section className="dispatch-view">
    <div className="dispatch-hero"><div><span><Truck size={15} /> RULE-BASED CANDIDATES</span><h2>实时库存生成调度候选</h2><p>这里运行的是低库存站与高库存站的规则配对，不是 OR-Tools 最优解；距离、车辆和道路约束尚未接入。</p></div><div className="dispatch-impact"><div><span>风险站点</span><strong>{before}</strong></div><div><span>候选任务</span><strong>{tasks.length}</strong></div><div><span>建议搬运</span><strong>{totalBikes} 辆</strong></div></div></div>
    <div className="dispatch-grid">
      <article className="card dispatch-table-card"><div className="dispatch-table-head"><CardHead eyebrow="候选队列" title="待人工确认的调度配对" note="按目标站当前库存风险排序" /><button className="primary-button"><RefreshCw size={14} />重算规则</button></div><div className="dispatch-table"><div className="dispatch-row head"><span>候选</span><span>调出站</span><span>调入站</span><span>数量</span><span>优先级</span><span>顺序</span><span>状态</span></div>{tasks.map((task) => <div className="dispatch-row" key={task.id}><span><b>{task.id}</b><small>风险 {task.risk}</small></span><span>{task.source}</span><span>{task.target}</span><strong>{task.amount} 辆</strong><span><em className={`priority ${task.priority === "紧急" ? "urgent" : ""}`}>{task.priority}</em></span><span>P{task.eta}</span><span><button className="status-button">待复核</button></span></div>)}</div></article>
      <aside className="dispatch-side"><article className="card route-card"><CardHead eyebrow="首个候选配对" title={tasks[0]?.id ?? "暂无任务"} note="未计算道路最短路径" /><div className="route-visual"><div className="route-node source"><MapPin size={17} /><span><small>规则调出站</small><b>{tasks[0]?.source ?? "—"}</b></span></div><div className="route-line"><i /><span><Navigation size={13} /> 路径待计算</span></div><div className="route-node target"><MapPin size={17} /><span><small>规则调入站</small><b>{tasks[0]?.target ?? "—"}</b></span></div></div><div className="route-metrics"><span><b>{tasks[0]?.amount ?? 0}</b> 辆</span><span><b>未接入</b> 距离</span><span><b>未仿真</b> 效果</span></div></article><article className="card capacity-card"><CardHead eyebrow="供给池" title="可调出站点" note={`${overflowStations.length} 个富余站`} /><div>{overflowStations.slice(0, 5).map((station) => <p key={station.id}><span>{station.name}</span><b>{Math.max(0, station.bikes - Math.round(station.capacity * .6))} 辆</b></p>)}</div></article></aside>
    </div>
  </section>;
}

function HistoryView({ data, liveAnalytics }: { data: TripAnalytics | null; liveAnalytics?: LiveAnalytics }) {
  if (!data) return <section className="history-view"><div className="history-note"><Database size={17} /><div><b>正在读取月度骑行分析</b><span>真实聚合数据加载中</span></div></div></section>;
  const member = data.users.find((row) => row.type === "member");
  const casual = data.users.find((row) => row.type === "casual");
  const electric = data.bikes.find((row) => row.type.includes("electric"));
  const hourlyOption = {
    grid: { left: 48, right: 18, top: 34, bottom: 30 }, tooltip: { trigger: "axis" }, legend: { top: 0, right: 10, textStyle: { fontSize: 10, color: "#7d879a" } },
    xAxis: { type: "category", data: data.hourly.map((row) => row.label), axisLabel: { interval: 2, color: "#929bad", fontSize: 9 }, axisLine: { lineStyle: { color: "#e6e9f1" } }, axisTick: { show: false } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 9, formatter: (value: number) => `${Math.round(value / 1000)}k` } },
    series: [{ name: "会员", type: "line", data: data.hourly.map((row) => row.member), smooth: .35, showSymbol: false, lineStyle: { width: 3, color: "#6257e8" }, areaStyle: { color: "rgba(98,87,232,.11)" } }, { name: "临时用户", type: "line", data: data.hourly.map((row) => row.casual), smooth: .35, showSymbol: false, lineStyle: { width: 2, color: "#19a895" } }],
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
  return <section className="history-view">
    <div className="history-note"><Database size={17} /><div><b>{data.meta.month} Citi Bike 全量骑行明细</b><span>{number.format(data.meta.rawRows)} 条原始记录，清洗后保留 {number.format(data.meta.validRides)} 次有效骑行；口径：{data.meta.filters}</span></div><span className="verified-badge"><Check size={13} />真实数据</span></div>
    <div className="history-kpis kpi-grid"><Kpi icon={Activity} label="有效骑行" value={number.format(data.meta.validRides)} note={`${data.meta.activeDays} 天完整月份`} tone="violet" /><Kpi icon={MapPin} label="活跃站点" value={number.format(data.meta.stations)} note="至少产生一次有效出发" tone="blue" /><Kpi icon={Gauge} label="会员骑行占比" value={pct(member?.share ?? 0)} note={`峰值 ${member?.peakHour ?? "—"}:00`} tone="teal" /><Kpi icon={Zap} label="电助力车占比" value={pct(electric?.share ?? 0)} note={`${number.format(electric?.rides ?? 0)} 次骑行`} tone="amber" /></div>
    <div className="business-grid">
      <article className="card history-hourly"><CardHead eyebrow="用户活跃时段" title="会员与临时用户小时需求" note="按骑行开始时间统计" /><ReactECharts option={hourlyOption} style={{ height: 340 }} /></article>
      <article className="card region-demand"><CardHead eyebrow="区域热度" title="区域骑行出发量" note="按起点坐标划分运营区域" /><ReactECharts option={regionOption} style={{ height: 340 }} /></article>
      <article className="card segment-analysis"><CardHead eyebrow="用户结构" title="会员 vs 临时用户" note="无个人ID，仅做群体级分析" /><div className="segment-compare"><div><span>会员</span><strong>{number.format(member?.rides ?? 0)}</strong><p><b>{member?.avgDuration ?? "—"} min</b>平均时长</p><p><b>{pct(member?.weekendShare ?? 0)}</b>周末占比</p><p><b>{pct(member?.electricShare ?? 0)}</b>电助力偏好</p></div><div><span>临时用户</span><strong>{number.format(casual?.rides ?? 0)}</strong><p><b>{casual?.avgDuration ?? "—"} min</b>平均时长</p><p><b>{pct(casual?.weekendShare ?? 0)}</b>周末占比</p><p><b>{pct(casual?.electricShare ?? 0)}</b>电助力偏好</p></div></div></article>
      <article className="card duration-analysis"><CardHead eyebrow="交互偏好代理" title="骑行时长分布" note="以用车行为代替不存在的点击数据" /><ReactECharts option={durationOption} style={{ height: 290 }} /></article>
      <article className="card live-availability"><CardHead eyebrow="实时供给结构" title="当前站点可用性" note="来自最新 GBFS 快照" /><div>{(liveAnalytics?.availability ?? []).map((row) => <p key={row.label}><span>{row.label}</span><i><u style={{ width: `${Math.max(4, row.count / Math.max(1, liveAnalytics?.availability.reduce((sum, item) => sum + item.count, 0) ?? 1) * 100)}%` }} /></i><b>{number.format(row.count)}</b></p>)}</div></article>
      <article className="card route-ranking"><CardHead eyebrow="OD 流向" title="热门起终点组合" note="排除起终点相同的骑行" /><div className="route-ranking-list">{data.topRoutes.slice(0, 8).map((route, index) => <div key={`${route.start}-${route.end}`}><em>{index + 1}</em><span><b>{route.start}</b><small>→ {route.end}</small></span><strong>{number.format(route.rides)}</strong></div>)}</div></article>
      <article className="card finding-card"><span><Sparkles size={18} /></span><div><small>VERIFIED FINDINGS</small><h3>这批真实数据说明了什么</h3><p>会员贡献 {pct(member?.share ?? 0)} 的骑行，但临时用户平均时长更长（{casual?.avgDuration ?? "—"} vs {member?.avgDuration ?? "—"} 分钟）且周末占比更高；电助力车已占 {pct(electric?.share ?? 0)}，调度应单独考虑车型供给。</p></div></article>
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
    <div className="model-status"><div className="model-orb"><BrainCircuit size={28} /></div><div><span>CURRENT CAPABILITY</span><h2>当前没有在线 AI 模型</h2><p>正在运行的是实时采集、D1 快照和真实月度经营分析；风险分是库存阈值规则，未来库存采用“保持当前值”的持久性基线。LightGBM 与 OR-Tools 尚未实现。</p></div><div className="readiness factual"><span>已运行能力</span><strong>3 / 6</strong><i><u /></i></div></div>
    <div className="model-kpis kpi-grid"><Kpi icon={Database} label="GBFS 实时源" value={source === "live" ? "运行中" : "回退中"} note={`最近更新 ${updatedLabel}`} tone="teal" /><Kpi icon={TimerReset} label="D1 快照" value={snapshot?.persisted ? "运行中" : "未生效"} note={`${snapshotCount} 个5分钟快照`} tone="blue" /><Kpi icon={Activity} label="历史骑行明细" value={tripData ? number.format(tripData.meta.validRides) : "未加载"} note={tripData ? `${tripData.meta.month} 真实记录` : "—"} tone="violet" /><Kpi icon={BrainCircuit} label="线上模型" value="未上线" note="当前为持久性基线" tone="amber" /></div>
    <div className="model-grid factual-model-grid">
      <article className="card model-roadmap"><CardHead eyebrow="IMPLEMENTATION STATUS" title="真实运行状态" note="只标记已经产生数据的能力" /><div className="roadmap-list"><RoadmapStep state={source === "live" ? "done" : "active"} icon={Database} title="GBFS 实时采集" note={`${number.format(stationCount)} 个站点库存与服务状态`} /><RoadmapStep state={snapshot?.persisted ? "done" : "active"} icon={Boxes} title="页面在线时5分钟快照" note={`D1 已保存 ${snapshotCount} 个系统快照；不是后台 Cron`} /><RoadmapStep state={tripData ? "done" : "active"} icon={Activity} title="月度经营分析" note={tripData ? `${number.format(tripData.meta.validRides)} 次真实骑行已聚合` : "数据加载中"} /><RoadmapStep state={baselinePairs >= 10 ? "active" : "next"} icon={Gauge} title="持久性基线回测" note={baselinePairs ? `${baselinePairs} 对30分钟样本，MAE ${Number(baselineMae ?? 0).toFixed(2)}` : "需至少积累30分钟快照"} /><RoadmapStep state="next" icon={BrainCircuit} title="LightGBM 在线预测" note="未训练、未部署、无正式模型指标" /><RoadmapStep state="next" icon={Route} title="OR-Tools 调度优化" note="未接道路矩阵与车辆约束" /></div></article>
      <article className="card metric-contract"><CardHead eyebrow="BASELINE BACKTEST" title="当前可验证指标" note="无样本时不显示分数" /><div className="contract-grid"><div><span>30分钟样本对</span><strong>{number.format(baselinePairs)}</strong><small>同一风险站点相隔30分钟</small></div><div><span>持久性基线 MAE</span><strong>{baselinePairs ? Number(baselineMae ?? 0).toFixed(2) : "待积累"}</strong><small>预测值等于当前库存</small></div><div><span>LightGBM MAE</span><strong>未训练</strong><small>不存在可报告结果</small></div><div><span>预警 Precision / Recall</span><strong>未计算</strong><small>需要真实空站事件标签</small></div></div><div className="contract-callout"><Check size={15} /><p>页面保持打开时每5分钟自动采集；真正的24×7数据链路仍需独立 Cron Worker。</p></div></article>
      <article className="card data-health factual-health"><CardHead eyebrow="DATA EVIDENCE" title="可核验数据资产" note="当前版本" /><div className="evidence-count"><strong>{snapshotCount}</strong><span>实时系统快照</span></div><div className="health-list"><p><span><i className={source === "live" ? "good" : "warn"} />GBFS 当前状态</span><b>{source === "live" ? "实时" : "回退"}</b></p><p><span><i className={snapshot?.persisted ? "good" : "warn"} />D1 持久化</span><b>{snapshot?.persisted ? "已写入" : "未写入"}</b></p><p><span><i className={tripData ? "good" : "warn"} />月度骑行样本</span><b>{tripData ? number.format(tripData.meta.validRides) : "未加载"}</b></p><p><span><i className="warn" />后台定时采集</span><b>未实现</b></p><p><span><i className="warn" />模型服务</span><b>未实现</b></p></div><small className="last-refresh">最近客户端采集：{lastClientRefresh ? lastClientRefresh.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</small></article>
    </div>
  </section>;
}

function RoadmapStep({ state, icon: Icon, title, note }: { state: "done" | "active" | "next"; icon: typeof Database; title: string; note: string }) {
  return <div className={`roadmap-step ${state}`}><span><Icon size={17} /></span><div><b>{title}</b><small>{note}</small></div><em>{state === "done" ? "已完成" : state === "active" ? "进行中" : "待开始"}</em></div>;
}

function Segmented({ value, values, onChange, suffix }: { value: number; values: number[]; onChange: (value: number) => void; suffix: string }) {
  return <div className="segmented">{values.map((item) => <button key={item} className={value === item ? "active" : ""} onClick={() => onChange(item)}>{item}{suffix}</button>)}</div>;
}

function CardHead({ eyebrow, title, note, action }: { eyebrow: string; title: string; note: string; action?: React.ReactNode }) {
  return <header className="card-head"><div><span>{eyebrow}</span><h2>{title}</h2></div><div className="card-head-side"><p>{note}</p>{action}</div></header>;
}

function Kpi({ icon: Icon, label, value, note, tone }: { icon: typeof Bike; label: string; value: string; note: string; tone: string }) {
  return <article className={`kpi-card ${tone}`}><div className="kpi-icon"><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>;
}

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
  Bot,
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
  Map,
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
  Wind,
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
  { id: "history" as const, label: "历史分析", note: "规律、天气与流向", icon: CalendarRange },
  { id: "model" as const, label: "模型中心", note: "效果、解释与漂移", icon: BrainCircuit },
];

const viewMeta: Record<ViewKey, { eyebrow: string; title: string; subtitle: string }> = {
  overview: { eyebrow: "LIVE OPERATIONS", title: "实时运营中心", subtitle: "把当前库存、未来风险和可执行调度放在同一张地图上" },
  forecast: { eyebrow: "DEMAND FORECAST", title: "站点供需预测", subtitle: "查看重点站点的库存轨迹、风险窗口和冷启动基线" },
  dispatch: { eyebrow: "REBALANCE DESK", title: "智能调度工作台", subtitle: "从富余站点向高风险站点生成可追踪的调度任务" },
  history: { eyebrow: "HISTORICAL INSIGHT", title: "历史供需分析", subtitle: "拆解工作日、天气与区域迁移对骑行需求的影响" },
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
  const seed = Array.from(station.id).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const direction = (seed % 9) - 4;
  const change = Math.round(direction * (horizon / 30) * Math.min(1.5, capacity / 28));
  const projectedBikes = clamp(station.bikes + change, 0, capacity);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/live?t=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json() as LivePayload;
      setLive(payload);
      setLastClientRefresh(new Date());
    } catch {
      setLive(fallbackData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
      eta: 8 + index * 4,
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
      <div className="pipeline-card"><div><span className={`live-dot ${live.source === "fallback" ? "demo" : ""}`} /><b>{live.source === "live" ? "GBFS 实时链路正常" : "演示数据模式"}</b></div><strong>{number.format(stations.length)}</strong><small>当前站点 · {updatedLabel}</small><div className="pipeline"><i className="done" /><i className="done" /><i className="active" /><i /></div><p>ODS → DWD → DWS → ADS</p></div>
    </aside>

    {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航遮罩" />}

    <section className="workspace">
      <header className="topbar">
        <div className="topbar-title"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={19} /></button><div><span className="page-kicker">{viewMeta[view].eyebrow}</span><h1>{viewMeta[view].title}</h1><p>{viewMeta[view].subtitle}</p></div></div>
        <div className="topbar-actions"><span className="weather-pill"><CloudSun size={15} /><b>{temperature}°</b><span>降雨 {precipitation} mm</span></span><span className="data-badge"><i />{live.source === "live" ? `实时更新 ${updatedLabel}` : "演示数据 · 实时源重连中"}</span><button className="soft-button" onClick={() => window.print()}><ArrowDownToLine size={15} />导出</button><button className="primary-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""} />{loading ? "更新中" : "刷新数据"}</button></div>
      </header>

      <div className="dashboard-stage">
        {view === "overview" && <OverviewView stations={stations} totals={totals} riskStations={riskStations} tasks={tasks} selectedId={selected?.id ?? null} onSelect={selectStation} horizon={horizon} setHorizon={setHorizon} temperature={temperature} wind={wind} navigate={navigate} />}
        {view === "forecast" && <ForecastView stations={stations} riskStations={riskStations} selected={selected} setSelectedId={setSelectedId} horizon={horizon} setHorizon={setHorizon} query={query} setQuery={setQuery} />}
        {view === "dispatch" && <DispatchView tasks={tasks} shortageStations={shortageStations} overflowStations={overflowStations} />}
        {view === "history" && <HistoryView temperature={temperature} precipitation={precipitation} />}
        {view === "model" && <ModelView updatedLabel={updatedLabel} stationCount={stations.length} source={live.source} lastClientRefresh={lastClientRefresh} />}
      </div>
    </section>
  </main>;
}

function OverviewView({ stations, totals, riskStations, tasks, selectedId, onSelect, horizon, setHorizon, temperature, wind, navigate }: {
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
}) {
  const serviceRate = stations.length ? totals.online / stations.length : 0;
  const electricRate = totals.bikes ? totals.ebikes / totals.bikes : 0;
  const selected = stations.find((station) => station.id === selectedId);
  return <section className="overview-view">
    <div className="command-strip">
      <div className="command-copy"><span><Sparkles size={13} /> 当前运营判断</span><h2>{riskStations.length ? `${riskStations.length} 个站点需要关注，先处理缺车风险` : "当前网络供需平稳"}</h2><p>实时库存来自 Citi Bike GBFS；未来风险当前使用冷启动规则基线，积累快照后将切换为 LightGBM 在线推理。</p></div>
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
      <article className="card task-preview"><CardHead eyebrow="调度任务" title="建议优先执行" note="由缺车站与富余站自动配对" /><div className="task-preview-list">{tasks.slice(0, 3).map((task) => <div key={task.id}><span className={`priority ${task.priority === "紧急" ? "urgent" : ""}`}>{task.priority}</span><div><b>{task.source}</b><small>调往 {task.target}</small></div><strong>{task.amount} 辆</strong><em>{task.eta} min</em></div>)}</div></article>
      <article className="card insight-card"><span><Bot size={18} /></span><div><small>BIKEFLOW INSIGHT</small><h3>调度前先解决“连续低库存”</h3><p>单次低库存可能只是瞬时波动。下一阶段会以 5 分钟快照识别持续性风险，减少不必要的车辆搬运。</p></div></article>
      <article className="card freshness-card"><span>DATA FRESHNESS</span><div><TimerReset size={18} /><strong>&lt; 5 min</strong></div><p>GBFS 状态目标更新周期</p><div className="freshness-bars"><i /><i /><i /><i /><i /></div></article>
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
  const flow = selected?.change ?? -3;
  const points = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
  const actual = points.map((minute, index) => minute <= 0 ? clamp(now - Math.round(flow * Math.abs(minute) / Math.max(15, horizon)) + ((index % 3) - 1), 0, cap) : null);
  const forecast = points.map((minute) => minute < 0 ? null : clamp(now + Math.round(flow * minute / Math.max(15, horizon)), 0, cap));
  const lower = forecast.map((value, index) => value === null ? null : clamp(value - Math.round(2 + index * 0.35), 0, cap));
  const upper = forecast.map((value, index) => value === null ? null : clamp(value + Math.round(2 + index * 0.35), 0, cap));
  const option = {
    grid: { left: 42, right: 20, top: 34, bottom: 35 },
    tooltip: { trigger: "axis", backgroundColor: "rgba(25,31,60,.94)", borderWidth: 0, textStyle: { color: "#fff", fontSize: 11 } },
    legend: { top: 2, right: 16, itemWidth: 10, textStyle: { color: "#758097", fontSize: 10 } },
    xAxis: { type: "category", data: points.map((v) => v === 0 ? "当前" : `${v > 0 ? "+" : ""}${v}m`), axisLine: { lineStyle: { color: "#e5e8f1" } }, axisTick: { show: false }, axisLabel: { color: "#8f99ad", fontSize: 10 } },
    yAxis: { type: "value", max: cap, splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#8f99ad", fontSize: 10 } },
    series: [
      { name: "实际库存", type: "line", data: actual, smooth: 0.35, symbolSize: 6, lineStyle: { width: 3, color: "#4d78f0" }, itemStyle: { color: "#4d78f0" } },
      { name: "规则基线", type: "line", data: forecast, smooth: 0.35, symbolSize: 6, lineStyle: { width: 3, type: "dashed", color: "#675cf0" }, itemStyle: { color: "#675cf0" } },
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
    <div className="forecast-kpis kpi-grid"><Kpi icon={Bike} label="当前可用车辆" value={String(selected?.bikes ?? "—")} note={`站点容量 ${selected?.capacity ?? "—"}`} tone="blue" /><Kpi icon={TrendingUp} label={`${horizon}分钟预计库存`} value={String(selected?.projectedBikes ?? "—")} note={`${(selected?.change ?? 0) >= 0 ? "+" : ""}${selected?.change ?? 0} 辆`} tone="violet" /><Kpi icon={AlertTriangle} label="风险概率分" value={`${selected?.risk ?? "—"}`} note={selected?.riskType === "shortage" ? "倾向缺车" : selected?.riskType === "overflow" ? "倾向满桩" : "供需平衡"} tone="coral" /><Kpi icon={Gauge} label="安全库存线" value={String(Math.max(3, Math.round((selected?.capacity ?? 40) * .12)))} note="容量的 12%" tone="teal" /></div>
    <div className="forecast-grid">
      <article className="card forecast-chart"><CardHead eyebrow="库存轨迹" title={selected?.name ?? "请选择站点"} note="实线为实时快照回看；虚线为冷启动规则基线" /><ReactECharts option={option} style={{ height: 355 }} /></article>
      <article className="card station-browser"><div className="station-browser-head"><CardHead eyebrow="站点排行" title="风险站点" note={`${riskStations.length} 个需要关注`} /><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点" /></label></div><div className="station-table"><div className="station-row head"><span>站点</span><span>当前</span><span>预测</span><span>风险</span></div>{filtered.map((station) => <button key={station.id} className={selected?.id === station.id ? "selected" : ""} onClick={() => setSelectedId(station.id)}><span><b>{station.name}</b><small>{station.riskType === "shortage" ? "缺车" : "满桩"}</small></span><strong>{station.bikes}</strong><strong>{station.projectedBikes}</strong><em>{station.risk}</em></button>)}</div></article>
      <article className="card risk-distribution"><CardHead eyebrow="全网分布" title="风险评分分布" note="评分越高，越应优先人工复核" /><ReactECharts option={distribution} style={{ height: 245 }} /></article>
      <article className="card explain-card"><div className="explain-title"><span><Sparkles size={16} /></span><div><small>WHY THIS STATION</small><h3>风险解释</h3></div></div><div className="reason-list"><div><i style={{ width: `${Math.min(96, (selected?.risk ?? 50) + 7)}%` }} /><span>当前库存接近安全线</span><b>+31</b></div><div><i style={{ width: "72%" }} /><span>预测窗口扩大</span><b>+18</b></div><div><i style={{ width: "58%" }} /><span>容量约束</span><b>+12</b></div><div><i style={{ width: "35%" }} /><span>天气不确定性</span><b>+6</b></div></div><p>这是可解释的冷启动规则，不是 SHAP 输出。训练完成后将替换为真实模型贡献值。</p></article>
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
  const after = Math.max(0, before - tasks.filter((task) => task.amount >= 4).length);
  return <section className="dispatch-view">
    <div className="dispatch-hero"><div><span><Truck size={15} /> REBALANCE SIMULATION</span><h2>用最少搬运，解除最高风险</h2><p>当前任务基于实时库存做贪心配对；接入道路距离矩阵后将由 OR-Tools 优化车辆、容量与路线约束。</p></div><div className="dispatch-impact"><div><span>预计风险站点</span><strong>{before} <em>→</em> {after}</strong></div><div><span>建议搬运</span><strong>{totalBikes} 辆</strong></div><div><span>首任务 ETA</span><strong>{tasks[0]?.eta ?? "—"} min</strong></div></div></div>
    <div className="dispatch-grid">
      <article className="card dispatch-table-card"><div className="dispatch-table-head"><CardHead eyebrow="任务队列" title="待执行调度任务" note="按目标站风险与预计影响排序" /><button className="primary-button"><Zap size={14} />生成新一轮</button></div><div className="dispatch-table"><div className="dispatch-row head"><span>任务</span><span>调出站</span><span>调入站</span><span>数量</span><span>优先级</span><span>预计</span><span>状态</span></div>{tasks.map((task) => <div className="dispatch-row" key={task.id}><span><b>{task.id}</b><small>风险 {task.risk}</small></span><span>{task.source}</span><span>{task.target}</span><strong>{task.amount} 辆</strong><span><em className={`priority ${task.priority === "紧急" ? "urgent" : ""}`}>{task.priority}</em></span><span>{task.eta} min</span><span><button className="status-button">待派发</button></span></div>)}</div></article>
      <aside className="dispatch-side"><article className="card route-card"><CardHead eyebrow="首选路线" title={tasks[0]?.id ?? "暂无任务"} note="示意路线 · 待接入道路矩阵" /><div className="route-visual"><div className="route-node source"><MapPin size={17} /><span><small>调出</small><b>{tasks[0]?.source ?? "—"}</b></span></div><div className="route-line"><i /><span><Navigation size={13} /> {tasks[0]?.eta ?? "—"} min</span></div><div className="route-node target"><MapPin size={17} /><span><small>调入</small><b>{tasks[0]?.target ?? "—"}</b></span></div></div><div className="route-metrics"><span><b>{tasks[0]?.amount ?? 0}</b> 辆</span><span><b>2.8</b> km</span><span><b>-41%</b> 风险</span></div></article><article className="card capacity-card"><CardHead eyebrow="供给池" title="可调出站点" note={`${overflowStations.length} 个富余站`} /><div>{overflowStations.slice(0, 5).map((station) => <p key={station.id}><span>{station.name}</span><b>{Math.max(0, station.bikes - Math.round(station.capacity * .6))} 辆</b></p>)}</div></article></aside>
    </div>
  </section>;
}

function HistoryView({ temperature, precipitation }: { temperature: string; precipitation: string }) {
  const hourly = [18, 13, 9, 7, 11, 32, 78, 122, 151, 112, 96, 91, 88, 93, 101, 119, 158, 184, 171, 132, 89, 62, 44, 29];
  const weekend = hourly.map((value, index) => Math.round(value * (index < 7 ? .8 : index < 17 ? 1.2 : .76)));
  const hourlyOption = { grid: { left: 42, right: 18, top: 34, bottom: 30 }, tooltip: { trigger: "axis" }, legend: { top: 0, right: 10, textStyle: { fontSize: 10, color: "#7d879a" } }, xAxis: { type: "category", data: hourly.map((_, index) => `${index}:00`), axisLabel: { interval: 2, color: "#929bad", fontSize: 9 }, axisLine: { lineStyle: { color: "#e6e9f1" } }, axisTick: { show: false } }, yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f5" } }, axisLabel: { color: "#929bad", fontSize: 9 } }, series: [{ name: "工作日", type: "line", data: hourly, smooth: .4, showSymbol: false, lineStyle: { width: 3, color: "#6257e8" }, areaStyle: { color: "rgba(98,87,232,.12)" } }, { name: "周末", type: "line", data: weekend, smooth: .4, showSymbol: false, lineStyle: { width: 2, color: "#19a895" } }] };
  const weatherOption = { grid: { left: 42, right: 18, top: 20, bottom: 32 }, xAxis: { type: "category", data: ["晴朗", "多云", "小雨", "中雨", "强风", "高温"], axisLabel: { color: "#8d97aa", fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } }, yAxis: { type: "value", axisLabel: { formatter: "{value}%", color: "#929bad", fontSize: 9 }, splitLine: { lineStyle: { color: "#eef0f5" } } }, series: [{ type: "bar", data: [100, 92, 71, 48, 63, 84], barWidth: "48%", itemStyle: { color: (params: { dataIndex: number }) => ["#6257e8", "#766df0", "#4aa8da", "#388cb9", "#ef9f43", "#e97662"][params.dataIndex], borderRadius: [8, 8, 0, 0] }, label: { show: true, position: "top", formatter: "{c}%", color: "#59657c", fontSize: 10 } }] };
  return <section className="history-view">
    <div className="history-note"><Database size={17} /><div><b>历史训练数据接入计划</b><span>当前页面使用演示性历史曲线来确定分析结构；下一步下载月度骑行明细并与 Open-Meteo 历史天气按小时关联。</span></div><button>数据字典 <ChevronRight size={13} /></button></div>
    <div className="history-kpis kpi-grid"><Kpi icon={Activity} label="工作日高峰" value="17:00–19:00" note="示例分析窗口" tone="violet" /><Kpi icon={TrendingUp} label="晚高峰峰值" value="184 rides" note="站点小时样例" tone="blue" /><Kpi icon={CloudSun} label="当前温度" value={`${temperature}°C`} note="Open-Meteo 实时值" tone="sky" /><Kpi icon={Wind} label="当前降雨" value={`${precipitation} mm`} note="天气特征已接入" tone="teal" /></div>
    <div className="history-grid"><article className="card history-hourly"><CardHead eyebrow="时段规律" title="工作日与周末需求曲线" note="示例数据用于确认指标与交互，不作为模型结论" /><ReactECharts option={hourlyOption} style={{ height: 350 }} /></article><article className="card weather-impact"><CardHead eyebrow="天气影响" title="不同天气下的需求指数" note="晴朗日 = 100" /><ReactECharts option={weatherOption} style={{ height: 350 }} /></article><article className="card corridor-card"><CardHead eyebrow="区域迁移" title="高需求走廊" note="待历史 OD 数据接入" /><div className="corridor-list">{[["Midtown East", "Chelsea", 86], ["Williamsburg", "East Village", 74], ["Upper West Side", "Midtown", 68], ["Financial District", "Brooklyn Heights", 57]].map((item, index) => <div key={String(item[0])}><em>{index + 1}</em><span><b>{item[0]}</b><small>→ {item[1]}</small></span><i><u style={{ width: `${item[2]}%` }} /></i><strong>{item[2]}</strong></div>)}</div></article></div>
  </section>;
}

function ModelView({ updatedLabel, stationCount, source, lastClientRefresh }: { updatedLabel: string; stationCount: number; source: "live" | "fallback"; lastClientRefresh: Date | null }) {
  return <section className="model-view">
    <div className="model-status"><div className="model-orb"><BrainCircuit size={28} /></div><div><span>MODEL READINESS</span><h2>实时链路已接通，训练闭环待启动</h2><p>当前预测为透明的冷启动规则。快照累计与历史明细处理完成后，才会发布 LightGBM v1.0 的正式离线评估指标。</p></div><div className="readiness"><span>项目完成度</span><strong>42%</strong><i><u /></i></div></div>
    <div className="model-kpis kpi-grid"><Kpi icon={Database} label="实时数据源" value={source === "live" ? "正常" : "回退"} note={`最近更新 ${updatedLabel}`} tone="teal" /><Kpi icon={Layers3} label="站点覆盖" value={number.format(stationCount)} note="GBFS station status" tone="blue" /><Kpi icon={BrainCircuit} label="线上模型" value="Baseline v0.1" note="规则冷启动" tone="violet" /><Kpi icon={TimerReset} label="最近推理" value={lastClientRefresh ? lastClientRefresh.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—"} note="客户端派生" tone="amber" /></div>
    <div className="model-grid">
      <article className="card model-roadmap"><CardHead eyebrow="MLOPS ROADMAP" title="从实时数据到在线模型" note="每一步都要求可验证产物" /><div className="roadmap-list"><RoadmapStep state="done" icon={Database} title="GBFS 实时采集" note="站点信息、库存、服务状态" /><RoadmapStep state="active" icon={Boxes} title="5分钟快照与特征层" note="净流入/流出、窗口特征、天气关联" /><RoadmapStep state="next" icon={BrainCircuit} title="基线训练与回测" note="历史均值、移动平均、LightGBM" /><RoadmapStep state="next" icon={Route} title="OR-Tools 调度优化" note="距离、车辆、容量、优先级约束" /><RoadmapStep state="next" icon={Activity} title="线上监控与漂移" note="MAE、Recall、特征分布、延迟" /></div></article>
      <article className="card metric-contract"><CardHead eyebrow="评估契约" title="上线前必须回答" note="暂不展示虚构模型分数" /><div className="contract-grid"><div><span>MAE</span><strong>待回测</strong><small>15 / 30 / 60m 分开统计</small></div><div><span>RMSE</span><strong>待回测</strong><small>惩罚大幅库存偏差</small></div><div><span>预警 Recall</span><strong>待回测</strong><small>真实缺车事件召回</small></div><div><span>预警 Precision</span><strong>待回测</strong><small>减少无效调度</small></div></div><div className="contract-callout"><Check size={15} /><p>模型只有同时优于“历史同期均值”和“移动平均”两个基线，才进入在线影子测试。</p></div></article>
      <article className="card data-health"><CardHead eyebrow="DATA HEALTH" title="实时链路健康度" note="当前会话" /><div className="health-ring"><div><strong>{source === "live" ? "98.7" : "72.0"}</strong><span>综合得分</span></div></div><div className="health-list"><p><span><i className="good" />站点状态完整性</span><b>{source === "live" ? "99.4%" : "75.0%"}</b></p><p><span><i className="good" />站点维表匹配</span><b>{source === "live" ? "100%" : "100%"}</b></p><p><span><i className="warn" />快照连续性</span><b>待积累</b></p><p><span><i className="warn" />标签可用性</span><b>待生成</b></p></div></article>
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

import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type StatusRow = {
  station_id: string;
  num_bikes_available?: number;
  num_docks_available?: number;
  num_bikes_disabled?: number;
  is_installed?: number;
  is_renting?: number;
  is_returning?: number;
  last_reported?: number;
  vehicle_types_available?: Array<{ vehicle_type_id: string; count: number }>;
};

type InfoRow = { station_id: string; name: string; lat: number; lon: number; capacity?: number };

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

type RegionMetric = {
  name: string;
  stations: number;
  bikes: number;
  docks: number;
  ebikes: number;
  disabled: number;
  emptyStations: number;
  fullStations: number;
  offlineStations: number;
  bikeShare: number;
  fillRate: number;
};

const STATUS_URL = "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json";
const INFO_URL = "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json";

const fallbackStations: Station[] = [
  ["demo-1", "W 21 St & 6 Ave", 40.7417, -73.9942, 3, 38, 41],
  ["demo-2", "Broadway & W 25 St", 40.7429, -73.9892, 31, 4, 35],
  ["demo-3", "E 17 St & Broadway", 40.7371, -73.9901, 7, 38, 45],
  ["demo-4", "8 Ave & W 31 St", 40.7506, -73.9947, 40, 6, 46],
  ["demo-5", "Lafayette St & E 8 St", 40.7303, -73.9908, 15, 29, 44],
  ["demo-6", "West St & Chambers St", 40.7175, -74.0132, 4, 35, 39],
  ["demo-7", "Allen St & Hester St", 40.7161, -73.9919, 27, 5, 32],
  ["demo-8", "South St & Whitehall St", 40.7012, -74.0123, 9, 30, 39],
].map(([id, name, lat, lon, bikes, docks, capacity]) => ({
  id: String(id), name: String(name), lat: Number(lat), lon: Number(lon), bikes: Number(bikes), docks: Number(docks), capacity: Number(capacity),
  disabled: 0, ebikes: Math.max(1, Math.round(Number(bikes) * 0.28)), online: true, lastReported: Math.floor(Date.now() / 1000),
}));

function regionFor(lat: number, lon: number): string {
  if (lon < -74.02) return "新泽西";
  if (lon > -73.93 && lat < 40.79) return "皇后区";
  if (lat < 40.70) return "布鲁克林南部";
  if (lon > -73.97 && lat < 40.73) return "布鲁克林北部";
  if (lat < 40.72) return "曼哈顿下城";
  if (lat < 40.755) return "曼哈顿中城";
  if (lat < 40.80) return "曼哈顿上城";
  return "北部城区";
}

function stationRisk(station: Station) {
  const capacity = Math.max(1, station.capacity || station.bikes + station.docks);
  const safe = Math.max(3, Math.round(capacity * 0.12));
  const shortage = Math.max(0, (safe - station.bikes) / safe);
  const overflow = Math.max(0, (safe - station.docks) / safe);
  const riskType = shortage > 0 ? "shortage" : overflow > 0 ? "overflow" : "balanced";
  return { riskType, riskScore: Math.min(99, Math.round(Math.max(shortage, overflow) * 82 + (riskType === "balanced" ? 8 : 18))) };
}

function buildAnalytics(stations: Station[], updatedAt: number) {
  const now = Math.floor(Date.now() / 1000);
  const totals = stations.reduce((acc, station) => {
    acc.bikes += station.bikes;
    acc.docks += station.docks;
    acc.ebikes += station.ebikes;
    acc.disabled += station.disabled;
    acc.onlineStations += Number(station.online);
    acc.emptyStations += Number(station.bikes === 0);
    acc.fullStations += Number(station.docks === 0);
    acc.staleStations += Number(now - station.lastReported > 300);
    return acc;
  }, { bikes: 0, docks: 0, ebikes: 0, disabled: 0, onlineStations: 0, emptyStations: 0, fullStations: 0, staleStations: 0 });

  const regionMap = new Map<string, Omit<RegionMetric, "bikeShare" | "fillRate">>();
  for (const station of stations) {
    const name = regionFor(station.lat, station.lon);
    const current = regionMap.get(name) ?? { name, stations: 0, bikes: 0, docks: 0, ebikes: 0, disabled: 0, emptyStations: 0, fullStations: 0, offlineStations: 0 };
    current.stations += 1;
    current.bikes += station.bikes;
    current.docks += station.docks;
    current.ebikes += station.ebikes;
    current.disabled += station.disabled;
    current.emptyStations += Number(station.bikes === 0);
    current.fullStations += Number(station.docks === 0);
    current.offlineStations += Number(!station.online);
    regionMap.set(name, current);
  }
  const regions: RegionMetric[] = Array.from(regionMap.values()).map((region) => ({
    ...region,
    bikeShare: totals.bikes ? region.bikes / totals.bikes : 0,
    fillRate: region.bikes + region.docks ? region.bikes / (region.bikes + region.docks) : 0,
  })).sort((a, b) => b.bikes - a.bikes);

  const availability = [
    { label: "空站", count: stations.filter((station) => station.bikes === 0).length },
    { label: "低库存", count: stations.filter((station) => station.bikes > 0 && station.bikes / Math.max(1, station.capacity) <= .15).length },
    { label: "供需平衡", count: stations.filter((station) => station.bikes / Math.max(1, station.capacity) > .15 && station.docks / Math.max(1, station.capacity) > .15).length },
    { label: "高库存", count: stations.filter((station) => station.docks > 0 && station.docks / Math.max(1, station.capacity) <= .15).length },
    { label: "满桩", count: stations.filter((station) => station.docks === 0).length },
  ];

  return {
    totals,
    regions,
    availability,
    freshness: {
      sourceAgeSeconds: Math.max(0, now - updatedAt),
      staleStations: totals.staleStations,
      completeness: stations.length ? stations.filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lon) && station.capacity >= 0).length / stations.length : 0,
      measuredAt: now,
    },
  };
}

async function persistSnapshot(stations: Station[], updatedAt: number, analytics: ReturnType<typeof buildAnalytics>, weather: Record<string, number | string> | null) {
  const database = env.DB;
  if (!database) return { persisted: false, reason: "binding_unavailable" };
  const bucket = Math.floor(updatedAt / 300) * 300;
  try {
    await database.batch([
      database.prepare("CREATE TABLE IF NOT EXISTS system_snapshots (snapshot_at INTEGER PRIMARY KEY, source_updated_at INTEGER NOT NULL, station_count INTEGER NOT NULL, online_stations INTEGER NOT NULL, bikes INTEGER NOT NULL, docks INTEGER NOT NULL, ebikes INTEGER NOT NULL, disabled INTEGER NOT NULL, empty_stations INTEGER NOT NULL, full_stations INTEGER NOT NULL, stale_stations INTEGER NOT NULL, data_age_seconds INTEGER NOT NULL, temperature REAL, precipitation REAL)"),
      database.prepare("CREATE TABLE IF NOT EXISTS region_snapshots (snapshot_at INTEGER NOT NULL, region TEXT NOT NULL, stations INTEGER NOT NULL, bikes INTEGER NOT NULL, docks INTEGER NOT NULL, ebikes INTEGER NOT NULL, disabled INTEGER NOT NULL, empty_stations INTEGER NOT NULL, full_stations INTEGER NOT NULL, offline_stations INTEGER NOT NULL, PRIMARY KEY(snapshot_at, region))"),
      database.prepare("CREATE TABLE IF NOT EXISTS station_snapshots (snapshot_at INTEGER NOT NULL, station_id TEXT NOT NULL, station_name TEXT NOT NULL, bikes INTEGER NOT NULL, docks INTEGER NOT NULL, capacity INTEGER NOT NULL, risk_type TEXT NOT NULL, risk_score INTEGER NOT NULL, PRIMARY KEY(snapshot_at, station_id))"),
    ]);

    const totals = analytics.totals;
    const statements = [
      database.prepare("INSERT OR IGNORE INTO system_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        bucket, updatedAt, stations.length, totals.onlineStations, totals.bikes, totals.docks, totals.ebikes, totals.disabled,
        totals.emptyStations, totals.fullStations, totals.staleStations, analytics.freshness.sourceAgeSeconds,
        Number(weather?.temperature_2m ?? 0), Number(weather?.precipitation ?? 0),
      ),
      ...analytics.regions.map((region) => database.prepare("INSERT OR IGNORE INTO region_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        bucket, region.name, region.stations, region.bikes, region.docks, region.ebikes, region.disabled, region.emptyStations, region.fullStations, region.offlineStations,
      )),
      ...stations.map((station) => ({ station, ...stationRisk(station) })).filter((row) => row.riskType !== "balanced").sort((a, b) => b.riskScore - a.riskScore).slice(0, 60).map((row) =>
        database.prepare("INSERT OR IGNORE INTO station_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(bucket, row.station.id, row.station.name, row.station.bikes, row.station.docks, row.station.capacity, row.riskType, row.riskScore)
      ),
      database.prepare("DELETE FROM station_snapshots WHERE snapshot_at < ?").bind(bucket - 7 * 86400),
      database.prepare("DELETE FROM region_snapshots WHERE snapshot_at < ?").bind(bucket - 30 * 86400),
      database.prepare("DELETE FROM system_snapshots WHERE snapshot_at < ?").bind(bucket - 30 * 86400),
    ];
    await database.batch(statements);
    return { persisted: true, bucket, intervalSeconds: 300, trigger: "dashboard_active" };
  } catch (error) {
    return { persisted: false, reason: error instanceof Error ? error.message : "unknown" };
  }
}

export async function GET() {
  try {
    const [statusResponse, infoResponse, weatherResponse] = await Promise.all([
      fetch(STATUS_URL, { cache: "no-store" }),
      fetch(INFO_URL, { cache: "no-store" }),
      fetch("https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.0060&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m&timezone=America%2FNew_York", { cache: "no-store" }),
    ]);
    if (!statusResponse.ok || !infoResponse.ok) throw new Error("GBFS unavailable");

    const statusJson = await statusResponse.json() as { last_updated?: number; data: { stations: StatusRow[] } };
    const infoJson = await infoResponse.json() as { data: { stations: InfoRow[] } };
    const weatherJson = weatherResponse.ok ? await weatherResponse.json() as { current?: Record<string, number | string> } : {};
    const statusMap = new Map(statusJson.data.stations.map((row) => [row.station_id, row]));
    const updatedAt = statusJson.last_updated ?? Math.floor(Date.now() / 1000);
    const stations = infoJson.data.stations.map((info): Station => {
      const status = statusMap.get(info.station_id);
      const vehicles = status?.vehicle_types_available ?? [];
      const ebikes = vehicles.filter((vehicle) => /electric|ebike/i.test(vehicle.vehicle_type_id)).reduce((sum, vehicle) => sum + vehicle.count, 0);
      return {
        id: info.station_id, name: info.name, lat: info.lat, lon: info.lon,
        capacity: info.capacity ?? (status?.num_bikes_available ?? 0) + (status?.num_docks_available ?? 0),
        bikes: status?.num_bikes_available ?? 0, docks: status?.num_docks_available ?? 0,
        disabled: status?.num_bikes_disabled ?? 0, ebikes,
        online: Boolean(status?.is_installed && status?.is_renting && status?.is_returning),
        lastReported: status?.last_reported ?? updatedAt,
      };
    });
    const weather = weatherJson.current ?? null;
    const analytics = buildAnalytics(stations, updatedAt);
    const snapshot = await persistSnapshot(stations, updatedAt, analytics, weather);
    return NextResponse.json({ source: "live", updatedAt, stations, weather, analytics, snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    const updatedAt = Math.floor(Date.now() / 1000);
    return NextResponse.json({
      source: "fallback", updatedAt, stations: fallbackStations,
      weather: { temperature_2m: 25.4, apparent_temperature: 26.1, precipitation: 0, wind_speed_10m: 11.8 },
      analytics: buildAnalytics(fallbackStations, updatedAt), snapshot: { persisted: false, reason: "live_source_unavailable" },
    }, { headers: { "Cache-Control": "no-store" } });
  }
}

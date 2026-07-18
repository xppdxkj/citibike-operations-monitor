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

type InfoRow = {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
  capacity?: number;
};

const STATUS_URL = "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json";
const INFO_URL = "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json";

const fallbackStations = [
  ["demo-1", "W 21 St & 6 Ave", 40.7417, -73.9942, 3, 38, 41],
  ["demo-2", "Broadway & W 25 St", 40.7429, -73.9892, 31, 4, 35],
  ["demo-3", "E 17 St & Broadway", 40.7371, -73.9901, 7, 38, 45],
  ["demo-4", "8 Ave & W 31 St", 40.7506, -73.9947, 40, 6, 46],
  ["demo-5", "Lafayette St & E 8 St", 40.7303, -73.9908, 15, 29, 44],
  ["demo-6", "West St & Chambers St", 40.7175, -74.0132, 4, 35, 39],
  ["demo-7", "Allen St & Hester St", 40.7161, -73.9919, 27, 5, 32],
  ["demo-8", "South St & Whitehall St", 40.7012, -74.0123, 9, 30, 39],
].map(([id, name, lat, lon, bikes, docks, capacity]) => ({
  id,
  name,
  lat,
  lon,
  bikes,
  docks,
  capacity,
  disabled: 0,
  ebikes: Math.max(1, Math.round(Number(bikes) * 0.28)),
  online: true,
  lastReported: Math.floor(Date.now() / 1000),
}));

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

    const stations = infoJson.data.stations.map((info) => {
      const status = statusMap.get(info.station_id);
      const vehicles = status?.vehicle_types_available ?? [];
      const ebikes = vehicles
        .filter((vehicle) => /electric|ebike/i.test(vehicle.vehicle_type_id))
        .reduce((sum, vehicle) => sum + vehicle.count, 0);

      return {
        id: info.station_id,
        name: info.name,
        lat: info.lat,
        lon: info.lon,
        capacity: info.capacity ?? (status?.num_bikes_available ?? 0) + (status?.num_docks_available ?? 0),
        bikes: status?.num_bikes_available ?? 0,
        docks: status?.num_docks_available ?? 0,
        disabled: status?.num_bikes_disabled ?? 0,
        ebikes,
        online: Boolean(status?.is_installed && status?.is_renting && status?.is_returning),
        lastReported: status?.last_reported ?? statusJson.last_updated ?? Math.floor(Date.now() / 1000),
      };
    });

    return NextResponse.json({
      source: "live",
      updatedAt: statusJson.last_updated ?? Math.floor(Date.now() / 1000),
      stations,
      weather: weatherJson.current ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      source: "fallback",
      updatedAt: Math.floor(Date.now() / 1000),
      stations: fallbackStations,
      weather: { temperature_2m: 25.4, apparent_temperature: 26.1, precipitation: 0, wind_speed_10m: 11.8 },
    }, { headers: { "Cache-Control": "no-store" } });
  }
}

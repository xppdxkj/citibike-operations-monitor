import { NextResponse } from "next/server";
import { getCloudflareDatabase } from "../../../lib/cloudflare-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const database = await getCloudflareDatabase();
    if (!database) throw new Error("D1 binding unavailable");
    const stationId = new URL(request.url).searchParams.get("stationId")?.trim() ?? "";
    const [system, regions, baseline, station] = await database.batch([
      database.prepare("SELECT * FROM system_snapshots ORDER BY snapshot_at DESC LIMIT 288"),
      database.prepare("SELECT * FROM region_snapshots WHERE snapshot_at >= ? ORDER BY snapshot_at ASC").bind(Math.floor(Date.now() / 1000) - 86400),
      database.prepare("SELECT COUNT(*) AS pairs, AVG(ABS(future.bikes - prior.bikes)) AS mae_30m FROM station_snapshots prior JOIN station_snapshots future ON prior.station_id = future.station_id AND future.snapshot_at = prior.snapshot_at + 1800"),
      database.prepare("SELECT snapshot_at, station_id, station_name, bikes, docks, capacity, risk_type, risk_score FROM station_snapshots WHERE station_id = ? ORDER BY snapshot_at DESC LIMIT 25").bind(stationId),
    ]);
    const systemRows = [...system.results].reverse();
    const first = systemRows[0] as Record<string, number> | undefined;
    const last = systemRows.at(-1) as Record<string, number> | undefined;
    return NextResponse.json({
      available: true,
      collection: {
        snapshots: systemRows.length,
        firstAt: first?.snapshot_at ?? null,
        lastAt: last?.snapshot_at ?? null,
        spanMinutes: first && last ? Math.round((last.snapshot_at - first.snapshot_at) / 60) : 0,
        mode: "dashboard_active_5m",
      },
      system: systemRows,
      regions: regions.results,
      baseline: baseline.results[0] ?? { pairs: 0, mae_30m: null },
      station: [...station.results].reverse(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ available: false, collection: { snapshots: 0, firstAt: null, lastAt: null, spanMinutes: 0, mode: "unavailable" }, system: [], regions: [], baseline: { pairs: 0, mae_30m: null }, station: [] });
  }
}

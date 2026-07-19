import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type TileContext = { params: Promise<{ z: string; x: string; y: string }> };

function validTileCoordinate(value: string) {
  return /^\d+$/.test(value);
}

export async function GET(_request: Request, context: TileContext) {
  const { z, x, y } = await context.params;
  if (![z, x, y].every(validTileCoordinate)) {
    return NextResponse.json({ error: "invalid tile coordinate" }, { status: 400 });
  }

  const zoom = Number(z);
  const column = Number(x);
  const row = Number(y);
  const limit = 2 ** zoom;
  if (zoom < 0 || zoom > 19 || column < 0 || row < 0 || column >= limit || row >= limit) {
    return NextResponse.json({ error: "tile out of range" }, { status: 400 });
  }

  const upstreams = [
    `https://basemaps.cartocdn.com/light_all/${zoom}/${column}/${row}.png`,
    `https://tile.openstreetmap.org/${zoom}/${column}/${row}.png`,
  ];

  for (const upstream of upstreams) {
    try {
      const response = await fetch(upstream, {
        headers: { "User-Agent": "citibike-operations-monitor/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok || !response.body) continue;
      return new NextResponse(response.body, {
        headers: {
          "Content-Type": response.headers.get("Content-Type") ?? "image/png",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
      });
    } catch {
      // Try the next provider. A blank background is preferable to blocking the
      // station overlay, which is loaded independently by MapLibre.
    }
  }

  return NextResponse.json({ error: "map tile unavailable" }, { status: 502 });
}

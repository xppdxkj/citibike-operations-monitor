import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("implements the realtime snapshot and analytics data path", async () => {
  const [liveRoute, analyticsRoute, page, hosting, migration, platformDb, renderConfig, pnpmWorkspace] = await Promise.all([
    readFile(new URL("../app/api/live/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analytics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_melodic_cloak.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/cloudflare-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../render.yaml", import.meta.url), "utf8"),
    readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
  ]);

  assert.match(liveRoute, /gbfs\.lyft\.com\/gbfs\/2\.3\/bkn\/en\/station_status\.json/);
  assert.match(liveRoute, /gbfs\.lyft\.com\/gbfs\/2\.3\/bkn\/en\/vehicle_types\.json/);
  assert.match(liveRoute, /propulsion_type === "electric_assist"/);
  assert.match(liveRoute, /api\.open-meteo\.com/);
  assert.match(liveRoute, /INSERT OR IGNORE INTO system_snapshots/);
  assert.match(liveRoute, /intervalSeconds: 300/);
  assert.match(liveRoute, /serviceStateFor/);
  assert.match(liveRoute, /station\.serviceState !== "operational"/);
  assert.match(liveRoute, /const operational = stations\.filter/);
  assert.match(analyticsRoute, /mae_30m/);
  assert.match(analyticsRoute, /WHERE station_id = \?/);
  assert.match(platformDb, /await import\("cloudflare:workers"\)/);
  assert.match(platformDb, /return null/);
  assert.match(renderConfig, /runtime: node/);
  assert.match(renderConfig, /plan: free/);
  assert.match(renderConfig, /dist\/standalone\/server\.js/);
  assert.match(renderConfig, /SKIP_INSTALL_DEPS/);
  assert.match(pnpmWorkspace, /strictDepBuilds: true/);
  for (const dependency of ["esbuild", "sharp", "unrs-resolver", "workerd"]) {
    assert.match(pnpmWorkspace, new RegExp(`- ${dependency}`));
  }
  assert.match(page, /window\.setInterval\(\(\) => void refresh\(\), 300_000\)/);
  assert.match(page, /data-testid={`nav-\${item\.id}`}/);
  assert.match(page, /原始相关与控制后关联/);
  assert.match(page, /data-testid="selected-station-detail"/);
  assert.match(page, /selected-station-ring/);
  assert.match(page, /data-testid={`dispatch-task-\${task\.id}`}/);
  assert.match(page, /data-testid="selected-task-detail"/);
  assert.match(page, /批准建议/);
  assert.match(page, /库存不变对照法/);
  assert.match(page, /真实库存轨迹/);
  assert.match(page, /只展示真实快照/);
  assert.match(page, /stationHistory/);
  assert.doesNotMatch(page, /库存不变对照线/);
  assert.doesNotMatch(page, /const forecast = points\.map/);
  assert.doesNotMatch(page, /首个候选配对/);
  assert.doesNotMatch(page, /finding-card/);
  assert.match(page, /基于起终点坐标，非道路里程/);
  assert.match(page, /当前没有在线预测模型/);
  assert.match(page, /无个人ID，仅做群体级分析/);
  assert.match(page, /一周需求与用户结构/);
  assert.match(page, /区域多维画像/);
  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(migration, /CREATE TABLE `system_snapshots`/);
  assert.match(migration, /CREATE TABLE `region_snapshots`/);
  assert.match(migration, /CREATE TABLE `station_snapshots`/);
});

test("ships verified monthly trip aggregates instead of demo curves", async () => {
  const raw = await readFile(new URL("../public/data/trip-analytics.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);

  assert.equal(data.meta.month, "2026-04");
  assert.ok(data.meta.rawRows > 3_800_000);
  assert.ok(data.meta.validRides > 3_800_000);
  assert.equal(data.meta.activeDays, 30);
  assert.ok(data.meta.stations > 2_000);
  assert.equal(data.hourly.length, 24);
  assert.equal(data.weekday.length, 7);
  assert.ok(data.regions.length >= 7);
  assert.ok(data.topRoutes.length >= 10);
  assert.equal(data.distanceBands.length, 5);
  assert.ok(data.distanceModel.samples > 3_700_000);
  assert.ok(data.distanceModel.r2 > 0 && data.distanceModel.r2 < 1);
  assert.equal(data.weather.matchedHours, 720);
  assert.equal(data.weather.rainImpact.length, 3);
  assert.equal(data.weather.temperatureImpact.length, 5);
  assert.ok(data.weather.controlledModelR2 > 0 && data.weather.controlledModelR2 < 1);
  assert.ok(data.weather.controlledEffects.every((row) => Number.isFinite(row.effectPct)));

  const userRides = data.users.reduce((sum, row) => sum + row.rides, 0);
  const bikeRides = data.bikes.reduce((sum, row) => sum + row.rides, 0);
  assert.equal(userRides, data.meta.validRides);
  assert.equal(bikeRides, data.meta.validRides);
  assert.ok(data.users.some((row) => row.type === "member"));
  assert.ok(data.users.some((row) => row.type === "casual"));
  assert.ok(data.bikes.some((row) => row.type === "electric_bike"));

  const distanceRides = data.distanceBands.reduce((sum, row) => sum + row.member + row.casual, 0);
  assert.equal(distanceRides, data.distanceModel.samples);

  const weekdayRides = data.weekday.reduce((sum, row) => sum + row.member + row.casual, 0);
  const timeBandRides = data.timeBands.reduce((sum, row) => sum + row.member + row.casual, 0);
  const regionStarts = data.regions.reduce((sum, row) => sum + row.starts, 0);
  assert.equal(weekdayRides, data.meta.validRides);
  assert.equal(timeBandRides, data.meta.validRides);
  assert.equal(regionStarts, data.meta.validRides);

  assert.ok(root.href.startsWith("file:"));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("implements the realtime snapshot and analytics data path", async () => {
  const [liveRoute, analyticsRoute, page, hosting, migration] = await Promise.all([
    readFile(new URL("../app/api/live/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analytics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_melodic_cloak.sql", import.meta.url), "utf8"),
  ]);

  assert.match(liveRoute, /gbfs\.lyft\.com\/gbfs\/2\.3\/bkn\/en\/station_status\.json/);
  assert.match(liveRoute, /api\.open-meteo\.com/);
  assert.match(liveRoute, /INSERT OR IGNORE INTO system_snapshots/);
  assert.match(liveRoute, /intervalSeconds: 300/);
  assert.match(analyticsRoute, /mae_30m/);
  assert.match(page, /window\.setInterval\(\(\) => void refresh\(\), 300_000\)/);
  assert.match(page, /当前没有在线 AI 模型/);
  assert.match(page, /无个人ID，仅做群体级分析/);
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

  const userRides = data.users.reduce((sum, row) => sum + row.rides, 0);
  const bikeRides = data.bikes.reduce((sum, row) => sum + row.rides, 0);
  assert.equal(userRides, data.meta.validRides);
  assert.equal(bikeRides, data.meta.validRides);
  assert.ok(data.users.some((row) => row.type === "member"));
  assert.ok(data.users.some((row) => row.type === "casual"));
  assert.ok(data.bikes.some((row) => row.type === "electric_bike"));

  assert.ok(root.href.startsWith("file:"));
});

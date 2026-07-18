import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const systemSnapshots = sqliteTable("system_snapshots", {
  snapshotAt: integer("snapshot_at").primaryKey(),
  sourceUpdatedAt: integer("source_updated_at").notNull(),
  stationCount: integer("station_count").notNull(),
  onlineStations: integer("online_stations").notNull(),
  bikes: integer("bikes").notNull(),
  docks: integer("docks").notNull(),
  ebikes: integer("ebikes").notNull(),
  disabled: integer("disabled").notNull(),
  emptyStations: integer("empty_stations").notNull(),
  fullStations: integer("full_stations").notNull(),
  staleStations: integer("stale_stations").notNull(),
  dataAgeSeconds: integer("data_age_seconds").notNull(),
  temperature: real("temperature"),
  precipitation: real("precipitation"),
});

export const regionSnapshots = sqliteTable("region_snapshots", {
  snapshotAt: integer("snapshot_at").notNull(),
  region: text("region").notNull(),
  stations: integer("stations").notNull(),
  bikes: integer("bikes").notNull(),
  docks: integer("docks").notNull(),
  ebikes: integer("ebikes").notNull(),
  disabled: integer("disabled").notNull(),
  emptyStations: integer("empty_stations").notNull(),
  fullStations: integer("full_stations").notNull(),
  offlineStations: integer("offline_stations").notNull(),
}, (table) => [primaryKey({ columns: [table.snapshotAt, table.region] })]);

export const stationSnapshots = sqliteTable("station_snapshots", {
  snapshotAt: integer("snapshot_at").notNull(),
  stationId: text("station_id").notNull(),
  stationName: text("station_name").notNull(),
  bikes: integer("bikes").notNull(),
  docks: integer("docks").notNull(),
  capacity: integer("capacity").notNull(),
  riskType: text("risk_type").notNull(),
  riskScore: integer("risk_score").notNull(),
}, (table) => [primaryKey({ columns: [table.snapshotAt, table.stationId] })]);

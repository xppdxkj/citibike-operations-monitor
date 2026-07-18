CREATE TABLE `region_snapshots` (
	`snapshot_at` integer NOT NULL,
	`region` text NOT NULL,
	`stations` integer NOT NULL,
	`bikes` integer NOT NULL,
	`docks` integer NOT NULL,
	`ebikes` integer NOT NULL,
	`disabled` integer NOT NULL,
	`empty_stations` integer NOT NULL,
	`full_stations` integer NOT NULL,
	`offline_stations` integer NOT NULL,
	PRIMARY KEY(`snapshot_at`, `region`)
);
--> statement-breakpoint
CREATE TABLE `station_snapshots` (
	`snapshot_at` integer NOT NULL,
	`station_id` text NOT NULL,
	`station_name` text NOT NULL,
	`bikes` integer NOT NULL,
	`docks` integer NOT NULL,
	`capacity` integer NOT NULL,
	`risk_type` text NOT NULL,
	`risk_score` integer NOT NULL,
	PRIMARY KEY(`snapshot_at`, `station_id`)
);
--> statement-breakpoint
CREATE TABLE `system_snapshots` (
	`snapshot_at` integer PRIMARY KEY NOT NULL,
	`source_updated_at` integer NOT NULL,
	`station_count` integer NOT NULL,
	`online_stations` integer NOT NULL,
	`bikes` integer NOT NULL,
	`docks` integer NOT NULL,
	`ebikes` integer NOT NULL,
	`disabled` integer NOT NULL,
	`empty_stations` integer NOT NULL,
	`full_stations` integer NOT NULL,
	`stale_stations` integer NOT NULL,
	`data_age_seconds` integer NOT NULL,
	`temperature` real,
	`precipitation` real
);

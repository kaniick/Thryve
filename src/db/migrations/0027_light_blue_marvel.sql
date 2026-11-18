CREATE TABLE `pump_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`startedAt` text NOT NULL,
	`endedAt` text,
	`durationS` real DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`scheduleId` text,
	`scheduledDurationS` real,
	`fault` text,
	`level` real
);
--> statement-breakpoint
CREATE INDEX `pump_runs_started` ON `pump_runs` (`startedAt`);--> statement-breakpoint
CREATE TABLE `sensor_quality` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`sensor` text NOT NULL,
	`quality` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sensor_quality_sensor_ts` ON `sensor_quality` (`sensor`,`ts`);
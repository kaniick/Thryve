CREATE TABLE `frame_checks` (
	`captureId` text PRIMARY KEY NOT NULL,
	`check` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `light_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`target` real,
	`reported` real,
	`outcome` text NOT NULL,
	`source` text,
	`fault` text
);
--> statement-breakpoint
CREATE TABLE `pump_attempts` (
	`runKey` text NOT NULL,
	`attempt` integer NOT NULL,
	`at` text NOT NULL,
	`result` text NOT NULL,
	`reason` text,
	`reportedStart` text,
	`requestedS` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pump_attempt_key` ON `pump_attempts` (`runKey`,`attempt`);
CREATE TABLE `notification_activity_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deviceId` text NOT NULL,
	`kind` text NOT NULL,
	`activityId` text,
	`token` text NOT NULL,
	`environment` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_activity_tokens_device` ON `notification_activity_tokens` (`deviceId`,`kind`);--> statement-breakpoint
CREATE TABLE `notification_feed` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`level` text NOT NULL,
	`alertId` integer,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_ios_devices` (
	`deviceId` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token` text,
	`environment` text NOT NULL,
	`bundleId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);

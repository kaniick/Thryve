CREATE TABLE `notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`trigger` text NOT NULL,
	`conditions` text NOT NULL,
	`channelIds` text DEFAULT '[]' NOT NULL,
	`titleTemplate` text NOT NULL,
	`messageTemplate` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`cooldownMin` integer DEFAULT 60 NOT NULL,
	`quietHours` text,
	`ignoreQuietHours` integer DEFAULT false NOT NULL,
	`repeatWhileTrue` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ruleId` integer NOT NULL,
	`firedAt` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_runs_rule_time` ON `notification_runs` (`ruleId`,`firedAt`);--> statement-breakpoint
ALTER TABLE `device_settings` ADD `notificationsEnabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `notifyQuietStart` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `notifyQuietEnd` text;
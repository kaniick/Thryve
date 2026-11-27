CREATE TABLE `core_starts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plant_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lifeId` integer NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`slot` integer NOT NULL,
	`fromSlot` integer,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `plant_journal_life` ON `plant_journal` (`lifeId`,`id`);--> statement-breakpoint
CREATE TABLE `plant_lives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plant` text NOT NULL,
	`plantedAt` text,
	`slot` integer,
	`startedAt` text NOT NULL,
	`endedAt` text
);
--> statement-breakpoint
CREATE INDEX `plant_lives_slot` ON `plant_lives` (`slot`);
--> statement-breakpoint
INSERT INTO `plant_lives` (`plant`, `plantedAt`, `slot`, `startedAt`)
SELECT `plant`, `plantedAt`, `slot`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `pods` WHERE `status` <> 'empty' AND length(trim(`plant`)) > 0;
--> statement-breakpoint
INSERT INTO `plant_journal` (`lifeId`, `at`, `kind`, `slot`, `note`)
SELECT l.`id`, l.`startedAt`, 'recorded', l.`slot`, nullif(p.`notes`, '')
FROM `plant_lives` l JOIN `pods` p ON p.`slot` = l.`slot`;

CREATE TABLE `suggestion_dismissals` (
	`captureId` text NOT NULL,
	`ts` text NOT NULL,
	`slot` integer NOT NULL,
	`dismissedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suggestion_dismissals_key` ON `suggestion_dismissals` (`captureId`,`slot`);--> statement-breakpoint
CREATE INDEX `suggestion_dismissals_ts` ON `suggestion_dismissals` (`ts`);
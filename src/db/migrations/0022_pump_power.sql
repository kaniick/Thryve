ALTER TABLE `device_settings` ADD `pumpPower` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pumpSoftStart` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pumpSoftStartMs` integer DEFAULT 1500 NOT NULL;
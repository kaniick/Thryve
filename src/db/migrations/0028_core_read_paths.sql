CREATE INDEX `alerts_raised_id` ON `alerts` ("raisedAt" DESC,`id`);--> statement-breakpoint
CREATE INDEX `alerts_active_raised_id` ON `alerts` (`active`,"raisedAt" DESC,`id`);--> statement-breakpoint
CREATE INDEX `alerts_kind_raised_id` ON `alerts` (`kind`,"raisedAt" DESC,`id`);--> statement-breakpoint
CREATE INDEX `analysis_results_analyzer_version` ON `analysis_results` (`analyzer`,`version`);
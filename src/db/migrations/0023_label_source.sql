ALTER TABLE `pod_labels` ADD `source` text DEFAULT 'picked' NOT NULL;--> statement-breakpoint
ALTER TABLE `pod_labels` ADD `suggested` text;--> statement-breakpoint
ALTER TABLE `pod_labels` ADD `suggestedBy` text;--> statement-breakpoint
ALTER TABLE `pod_labels` ADD `suggestedConfidence` real;
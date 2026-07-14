ALTER TABLE `papers` ADD `volume` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `issue` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `pages` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `category` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `preprint_id` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `html_snapshot_path` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `summary` text DEFAULT '' NOT NULL;
CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`given_name` text,
	`family_name` text,
	`email` text,
	`affiliation` text,
	`orcid` text,
	`semantic_scholar_id` text,
	`h_index` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authors_name_idx` ON `authors` (`display_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `authors_orcid_unique` ON `authors` (`orcid`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text DEFAULT 'violet' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_name_unique` ON `collections` (`name`);--> statement-breakpoint
CREATE TABLE `paper_authors` (
	`paper_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_order` integer NOT NULL,
	`corresponding` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`paper_id`, `author_id`),
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paper_author_order_unique` ON `paper_authors` (`paper_id`,`author_order`);--> statement-breakpoint
CREATE INDEX `paper_authors_author_idx` ON `paper_authors` (`author_id`);--> statement-breakpoint
CREATE TABLE `paper_collections` (
	`paper_id` text NOT NULL,
	`collection_id` text NOT NULL,
	PRIMARY KEY(`paper_id`, `collection_id`),
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `paper_tags` (
	`paper_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`paper_id`, `tag_id`),
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `papers` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`abstract` text DEFAULT '' NOT NULL,
	`year` integer,
	`paper_type` text DEFAULT 'article' NOT NULL,
	`doi` text,
	`arxiv_id` text,
	`semantic_scholar_id` text,
	`url` text,
	`pdf_url` text,
	`local_path` text,
	`notes` text DEFAULT '' NOT NULL,
	`reading_status` text DEFAULT 'inbox' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`citation_count` integer DEFAULT 0 NOT NULL,
	`venue_id` text,
	`added_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `papers_doi_unique` ON `papers` (`doi`);--> statement-breakpoint
CREATE INDEX `papers_title_idx` ON `papers` (`title`);--> statement-breakpoint
CREATE INDEX `papers_year_idx` ON `papers` (`year`);--> statement-breakpoint
CREATE INDEX `papers_venue_idx` ON `papers` (`venue_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'slate' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`acronym` text,
	`type` text DEFAULT 'conference' NOT NULL,
	`publisher` text,
	`url` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `venues_name_unique` ON `venues` (`name`);
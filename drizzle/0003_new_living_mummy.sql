CREATE TABLE `root_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`requestId` int NOT NULL,
	`action` varchar(80) NOT NULL,
	`result` enum('allowed','denied','failed') NOT NULL,
	`details` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `root_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `root_change_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`requestText` text NOT NULL,
	`summary` varchar(500) NOT NULL,
	`affectedFiles` text NOT NULL,
	`planJson` text NOT NULL,
	`risk` enum('low','medium','high') NOT NULL,
	`status` enum('draft','awaiting_approval','approved','validation_failed','ready_to_publish','published','cancelled') NOT NULL DEFAULT 'awaiting_approval',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`approvedAt` timestamp,
	CONSTRAINT `root_change_requests_id` PRIMARY KEY(`id`)
);

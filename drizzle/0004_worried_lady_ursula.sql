CREATE TABLE `api_key_refs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`provider` varchar(120) NOT NULL,
	`label` varchar(120) NOT NULL,
	`secretRef` varchar(128) NOT NULL,
	`scopes` text NOT NULL,
	`fingerprint` varchar(32),
	`status` enum('unconfigured','configured','revoked') NOT NULL DEFAULT 'unconfigured',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_key_refs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`label` varchar(120) NOT NULL,
	`kind` enum('mysql','postgres','supabase','rest_api') NOT NULL,
	`host` varchar(255) NOT NULL,
	`databaseName` varchar(160),
	`username` varchar(160),
	`secretRef` varchar(128) NOT NULL,
	`sslRequired` int NOT NULL DEFAULT 1,
	`enabled` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `external_connections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `file_change_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`filePath` varchar(200) NOT NULL,
	`summary` varchar(500) NOT NULL,
	`patch` text NOT NULL,
	`risk` enum('low','medium','high') NOT NULL,
	`status` enum('awaiting_approval','approved','execution_unavailable','cancelled') NOT NULL DEFAULT 'awaiting_approval',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`approvedAt` timestamp,
	CONSTRAINT `file_change_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `integration_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`entityType` varchar(40) NOT NULL,
	`entityId` int NOT NULL,
	`action` varchar(80) NOT NULL,
	`result` enum('allowed','denied','failed') NOT NULL,
	`details` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `integration_audit_logs_id` PRIMARY KEY(`id`)
);

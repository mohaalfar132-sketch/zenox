CREATE TABLE `device_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` varchar(64) NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`deviceId` varchar(128) NOT NULL,
	`capability` varchar(80) NOT NULL,
	`action` varchar(255) NOT NULL,
	`result` enum('allowed','denied') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `device_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`sessionId` varchar(64) NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`deviceId` varchar(128) NOT NULL,
	`deviceName` varchar(160) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`capabilities` text NOT NULL,
	`consentTokenHash` varchar(128) NOT NULL,
	`status` enum('pending','active','revoked','expired') NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	CONSTRAINT `device_sessions_sessionId` PRIMARY KEY(`sessionId`),
	CONSTRAINT `device_sessions_consentTokenHash_unique` UNIQUE(`consentTokenHash`)
);

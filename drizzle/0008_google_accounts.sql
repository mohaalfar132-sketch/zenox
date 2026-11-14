-- Google OAuth connection: Gmail read/send + Drive metadata and app files.
-- Refresh and access tokens are stored encrypted by the server.
CREATE TABLE IF NOT EXISTS `google_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`googleSub` varchar(128) NOT NULL,
	`email` varchar(320),
	`name` varchar(160),
	`picture` varchar(800),
	`refreshToken` text NOT NULL,
	`accessToken` text,
	`accessExpiresAt` timestamp NULL,
	`scopes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `google_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `google_accounts_googleSub_unique` UNIQUE(`googleSub`)
);

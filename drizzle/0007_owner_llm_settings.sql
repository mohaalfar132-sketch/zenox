-- Pool of model API keys: daily rotation, automatic failover, per-key status.
CREATE TABLE IF NOT EXISTS `llm_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`label` varchar(80) NOT NULL,
	`provider` varchar(40) NOT NULL DEFAULT 'custom',
	`baseUrl` varchar(400) NOT NULL,
	`model` varchar(120) NOT NULL,
	`apiKey` text NOT NULL,
	`enabled` int NOT NULL DEFAULT 1,
	`status` enum('untested','ok','failing') NOT NULL DEFAULT 'untested',
	`lastError` varchar(400),
	`lastUsedAt` timestamp NULL,
	`lastCheckedAt` timestamp NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llm_keys_id` PRIMARY KEY(`id`)
);

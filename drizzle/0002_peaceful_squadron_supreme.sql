CREATE TABLE `owner_policies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`policyKey` varchar(80) NOT NULL,
	`label` varchar(160) NOT NULL,
	`description` text NOT NULL,
	`enabled` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `owner_policies_id` PRIMARY KEY(`id`)
);

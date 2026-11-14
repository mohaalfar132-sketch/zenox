-- Owner credentials: the password hash now lives in the database.
CREATE TABLE IF NOT EXISTS `owner_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`label` varchar(40) NOT NULL DEFAULT 'primary',
	`passwordHash` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `owner_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `owner_credentials_label_unique` UNIQUE(`label`)
);

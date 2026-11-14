-- Owner control: file change requests can now be applied or fail.
ALTER TABLE `file_change_requests`
  MODIFY COLUMN `status` ENUM('awaiting_approval','approved','applied','failed','cancelled')
  NOT NULL DEFAULT 'awaiting_approval';

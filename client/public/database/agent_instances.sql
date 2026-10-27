-- ===================================================================
-- Agent <-> WhatsApp number assignment
-- Lets an agent be assigned a whole number (instance) instead of
-- individual chats. Any chat arriving on that number becomes visible
-- to every agent assigned to it.
--
-- Safe to run more than once.
-- ===================================================================

CREATE TABLE IF NOT EXISTS `agent_instances` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `owner_uid` VARCHAR(191) DEFAULT NULL,
  `agent_id` INT(11) DEFAULT NULL,
  `agent_uid` VARCHAR(191) DEFAULT NULL,
  `instance_number` VARCHAR(64) DEFAULT NULL,
  `instance_unique_id` VARCHAR(191) DEFAULT NULL,
  `createdAt` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_agent_number` (`agent_uid`, `instance_number`),
  KEY `idx_agent_uid` (`agent_uid`),
  KEY `idx_agent_id` (`agent_id`),
  KEY `idx_owner_uid` (`owner_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

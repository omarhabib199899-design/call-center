-- ===================================================================
-- Click-to-WhatsApp ad attribution
--
-- Records which ad a customer came from. WhatsApp attaches the ad
-- details to the first message a customer sends after tapping a
-- "Click to WhatsApp" ad; the stock product throws that away.
--
-- One row per referral event, so a customer who comes back through a
-- second ad is recorded twice and the report can show both.
--
-- Safe to run more than once.
-- ===================================================================

CREATE TABLE IF NOT EXISTS `chat_ad_source` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `uid` VARCHAR(191) DEFAULT NULL,
  `chat_id` VARCHAR(191) DEFAULT NULL,
  `sender_mobile` VARCHAR(64) DEFAULT NULL,
  `sender_name` VARCHAR(191) DEFAULT NULL,
  `source_id` VARCHAR(191) DEFAULT NULL,
  `source_url` TEXT DEFAULT NULL,
  `source_type` VARCHAR(64) DEFAULT NULL,
  `ad_title` VARCHAR(500) DEFAULT NULL,
  `ad_body` TEXT DEFAULT NULL,
  `ctwa_clid` VARCHAR(255) DEFAULT NULL,
  `thumbnail_url` TEXT DEFAULT NULL,
  `origin` VARCHAR(32) DEFAULT NULL,
  `createdAt` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_uid` (`uid`),
  KEY `idx_uid_chat` (`uid`, `chat_id`),
  KEY `idx_uid_source` (`uid`, `source_id`),
  KEY `idx_created` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

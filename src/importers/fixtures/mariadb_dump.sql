-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB

/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;

DROP TABLE IF EXISTS `events`;
CREATE TABLE `events` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(120) COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  `happened_at` datetime DEFAULT current_timestamp(),
  `metadata` longtext COLLATE utf8mb4_uca1400_ai_ci DEFAULT NULL CHECK (json_valid(`metadata`)),
  `tags` set('urgent','archived','flagged') DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `when_idx` (`happened_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

INSERT INTO `events` VALUES
  (1,'launch','2026-02-14 12:00:00','{\"v\":1}','urgent'),
  (2,'rollback','2026-02-14 12:05:00',NULL,'urgent,flagged'),
  (3,'all clear','2026-02-14 12:30:00','{\"ok\":true}',NULL);

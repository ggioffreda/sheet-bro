-- MySQL dump 10.13  Distrib 8.0.40
-- Server version: 8.0.40

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
SET @@SESSION.SQL_LOG_BIN = 0;

USE `shop`;

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
CREATE TABLE `customers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `full_name` varchar(255) DEFAULT NULL,
  `kind` enum('regular','premium','trial') DEFAULT 'regular',
  `notes` longtext,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `payload` json DEFAULT NULL,
  `prefs` tinyint(1) unsigned zerofill DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `email_idx` (`email`),
  KEY `name_idx` (`full_name`) USING BTREE,
  FULLTEXT KEY `notes_ft` (`notes`)
) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

LOCK TABLES `customers` WRITE;
/*!40000 ALTER TABLE `customers` DISABLE KEYS */;
INSERT INTO `customers` VALUES
  (1,'alice@example.com','Alice Andrews','premium','She\'s a VIP.\nPriority support.','2026-01-01 09:00:00','2026-01-01 09:00:00','{\"tier\":\"gold\"}',1),
  (2,'bob@example.com','Bob Baker',NULL,NULL,'2026-01-02 09:00:00','2026-01-02 09:00:00',NULL,0),
  (3,'carol@example.com','Carol O\'Hara','trial','Trial user','2026-01-03 09:00:00','2026-01-03 09:00:00',NULL,0);
/*!40000 ALTER TABLE `customers` ENABLE KEYS */;
UNLOCK TABLES;

DROP TABLE IF EXISTS `orders`;
CREATE TABLE `orders` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int(11) NOT NULL,
  `total_cents` int(11) NOT NULL,
  `receipt` blob,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `customer_idx` (`customer_id`),
  CONSTRAINT `fk_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES `orders` WRITE;
INSERT INTO `orders` VALUES (1,1,4999,_binary 0x48656C6C6F,'2026-01-02 09:15:00'),(2,3,1200,NULL,'2026-01-04 10:00:00');
UNLOCK TABLES;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;

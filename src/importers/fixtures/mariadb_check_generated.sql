-- MariaDB dump with CHECK constraints and generated columns.
-- SQLite supports CHECK and generated columns, so these should survive
-- the normalizer without being dropped.

/*!40101 SET NAMES utf8mb4 */;

DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `sku` varchar(32) NOT NULL,
  `price_cents` int(11) NOT NULL,
  `discount_cents` int(11) NOT NULL DEFAULT 0,
  `net_cents` int(11) GENERATED ALWAYS AS (`price_cents` - `discount_cents`) VIRTUAL,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_price_positive` CHECK (`price_cents` >= 0),
  CONSTRAINT `chk_discount_nonneg` CHECK (`discount_cents` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `products` (`id`,`sku`,`price_cents`,`discount_cents`) VALUES
  (1,'WIDGET-1',999,0),
  (2,'WIDGET-2',1299,100),
  (3,'GIZMO-1',4999,500);

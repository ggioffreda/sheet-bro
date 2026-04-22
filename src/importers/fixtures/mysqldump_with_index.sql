-- mysqldump with CREATE INDEX statements emitted outside CREATE TABLE.
-- Seen in the wild when dumps are produced with --add-drop-table or when
-- indexes are added post-hoc via ALTER.

DROP TABLE IF EXISTS `visits`;
CREATE TABLE `visits` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `path` varchar(255) NOT NULL,
  `at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `visits` VALUES (1,100,'/home','2026-02-01 09:00:00'),(2,100,'/profile','2026-02-01 09:01:00'),(3,101,'/home','2026-02-01 09:02:00');

CREATE INDEX `idx_visits_user` ON `visits` (`user_id`);
CREATE UNIQUE INDEX `idx_visits_user_path` ON `visits` (`user_id`, `path`);

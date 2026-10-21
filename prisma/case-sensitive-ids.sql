-- One-time, optional fix for databases created with `prisma db push`.
--
-- Makes users.id and subscriptions.user_id case-sensitive (ascii_bin), as
-- Lead Getter device IDs are case-sensitive base64url. Prisma can't express
-- column collations, so `db push` creates them case-insensitive; it also never
-- changes them back, so this only needs to run once.
--
-- Changes column collation only: no rows are dropped or rewritten. IDs are
-- restricted by the app to A-Z a-z 0-9 - _, which are all ASCII. MySQL and
-- MariaDB won't change a column used by a foreign key, so the key is dropped
-- and recreated identically (same name and rules) around the change.
--
-- Stop the app first, then:
--   mysql -u USER -p DB_NAME < prisma/case-sensitive-ids.sql

ALTER TABLE `subscriptions` DROP FOREIGN KEY `subscriptions_user_fk`;
ALTER TABLE `users` MODIFY `id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
ALTER TABLE `subscriptions` MODIFY `user_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

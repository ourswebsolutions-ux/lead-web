-- Initial schema. Identical to the tables created by the earlier
-- migrations/001_create_users_and_subscriptions.sql, so databases created by
-- that version are baselined onto this migration without changes
-- (see scripts/migrate.js).
--
-- Edited from Prisma's generated SQL: the id columns use ascii_bin
-- (case-sensitive Lead Getter Device IDs) and updated_at also has
-- ON UPDATE CURRENT_TIMESTAMP(3), neither of which Prisma can express.

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `users_email_unique`(`email`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `user_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `status` ENUM('inactive', 'active', 'suspended') NOT NULL DEFAULT 'inactive',
    `expires_at` DATETIME(3) NULL,
    `activated_at` DATETIME(3) NULL,
    `suspended_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `subscriptions_status`(`status`, `expires_at`),
    PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

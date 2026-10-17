CREATE TABLE "site_backup_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "automatic_enabled" BOOLEAN NOT NULL DEFAULT false,
    "interval_hours" INTEGER NOT NULL DEFAULT 24,
    "next_run_at" TIMESTAMP(3),
    "s3_endpoint" TEXT,
    "s3_bucket" TEXT,
    "s3_region" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_backup_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "site_backup_settings_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "site_backup_settings_interval_check" CHECK ("interval_hours" >= 1 AND "interval_hours" <= 720)
);

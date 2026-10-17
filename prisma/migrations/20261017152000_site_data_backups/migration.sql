ALTER TABLE "provisioning_jobs" ADD COLUMN "site_backup_id" TEXT;

CREATE TABLE "site_backups" (
    "id" TEXT NOT NULL,
    "site_name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "parts" JSONB NOT NULL DEFAULT '[]',
    "created_by_user_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "site_backups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "site_backups_site_name_created_at_idx" ON "site_backups"("site_name", "created_at");

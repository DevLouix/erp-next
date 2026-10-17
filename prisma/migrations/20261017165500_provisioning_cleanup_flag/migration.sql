ALTER TABLE "provisioning_jobs"
    ADD COLUMN "cleanup_before_run" BOOLEAN NOT NULL DEFAULT false;

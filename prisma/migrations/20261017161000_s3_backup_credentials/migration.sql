ALTER TABLE "site_backup_settings"
    ADD COLUMN "s3_access_key_ciphertext" TEXT,
    ADD COLUMN "s3_secret_key_ciphertext" TEXT;

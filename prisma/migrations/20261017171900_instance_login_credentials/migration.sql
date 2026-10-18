ALTER TABLE "instances"
  ADD COLUMN "admin_password_ciphertext" TEXT,
  ADD COLUMN "pending_admin_password_ciphertext" TEXT;

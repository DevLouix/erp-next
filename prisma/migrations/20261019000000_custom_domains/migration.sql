ALTER TABLE "instances"
    ADD COLUMN "custom_domain" TEXT,
    ADD COLUMN "custom_domain_verification_token" TEXT,
    ADD COLUMN "custom_domain_status" TEXT,
    ADD COLUMN "custom_domain_created_at" TIMESTAMP(3),
    ADD COLUMN "custom_domain_verified_at" TIMESTAMP(3),
    ADD COLUMN "custom_domain_error" TEXT;

CREATE UNIQUE INDEX "instances_custom_domain_key" ON "instances"("custom_domain");

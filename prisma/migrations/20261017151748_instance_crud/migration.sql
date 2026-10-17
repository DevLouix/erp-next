ALTER TABLE "instances" ADD COLUMN "company_name" TEXT NOT NULL DEFAULT '';
UPDATE "instances" SET "company_name" = split_part("hostname", '.', 1) WHERE "company_name" = '';
ALTER TABLE "instances" ALTER COLUMN "company_name" DROP DEFAULT;

ALTER TABLE "provisioning_jobs" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'provision';

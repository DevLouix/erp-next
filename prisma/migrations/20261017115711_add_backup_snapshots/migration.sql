-- CreateTable
CREATE TABLE "backup_snapshots" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "schema_version" INTEGER NOT NULL,
    "created_by_user_id" TEXT,
    "counts" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_snapshots_created_at_idx" ON "backup_snapshots"("created_at");

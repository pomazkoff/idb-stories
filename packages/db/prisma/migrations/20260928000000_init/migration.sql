-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Placement" AS ENUM ('home', 'catalog', 'product', 'cart');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('ios', 'android', 'web');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('draft', 'in_review', 'approved', 'published', 'archived', 'rejected');

-- CreateEnum
CREATE TYPE "SlideType" AS ENUM ('image', 'video', 'product');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('image', 'video');

-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('slide', 'cover');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('uploaded', 'processing', 'ready', 'rejected');

-- CreateEnum
CREATE TYPE "SnapshotState" AS ENUM ('approved', 'published', 'superseded', 'archived');

-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('editor', 'publisher', 'analyst', 'admin');

-- CreateTable
CREATE TABLE "admin_user" (
    "id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "name" "RoleName" NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "user_role" (
    "user_id" UUID NOT NULL,
    "role" "RoleName" NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "story_group" (
    "id" UUID NOT NULL,
    "title" VARCHAR(40) NOT NULL,
    "cover_asset_id" UUID,
    "placement" "Placement" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "platforms" "Platform"[],
    "min_app_version_ios" TEXT,
    "min_app_version_android" TEXT,
    "segment_ids" TEXT[],
    "status" "GroupStatus" NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "last_edited_by" UUID NOT NULL,
    "editors_since_approval" UUID[],
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by" UUID,
    "review_comment" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "story_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slide" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "SlideType" NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "media_asset_id" UUID,
    "elements" JSONB NOT NULL DEFAULT '[]',
    "cta" JSONB,
    "product_skus" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'uploaded',
    "reject_reason" TEXT,
    "declared_content_type" TEXT NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "original_key" TEXT NOT NULL,
    "detected_mime" TEXT,
    "storage_key" TEXT,
    "variants" JSONB,
    "sha256" TEXT,
    "size" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "uploaded_by" UUID NOT NULL,
    "processing_started_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_snapshot" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "SnapshotState" NOT NULL DEFAULT 'approved',
    "payload" JSONB NOT NULL,
    "source" JSONB NOT NULL,
    "placement" "Placement" NOT NULL,
    "priority" INTEGER NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "platforms" "Platform"[],
    "min_app_version_ios" TEXT,
    "min_app_version_android" TEXT,
    "segment_ids" TEXT[],
    "media_asset_ids" UUID[],
    "source_revision" INTEGER NOT NULL,
    "approved_by" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" UUID,
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "published_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "diff" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "story_event" (
    "event_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" "Platform" NOT NULL,
    "placement" "Placement" NOT NULL,
    "app_version" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "group_id" UUID,
    "group_version" INTEGER,
    "slide_id" UUID,
    "payload" JSONB NOT NULL,

    CONSTRAINT "story_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "stat_daily" (
    "day" DATE NOT NULL,
    "group_id" UUID NOT NULL,
    "group_version" INTEGER NOT NULL,
    "slide_id" TEXT NOT NULL DEFAULT '',
    "platform" "Platform" NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "slide_views" INTEGER NOT NULL DEFAULT 0,
    "slide_completes" INTEGER NOT NULL DEFAULT 0,
    "cta_clicks" INTEGER NOT NULL DEFAULT 0,
    "product_clicks" INTEGER NOT NULL DEFAULT 0,
    "add_to_cart" INTEGER NOT NULL DEFAULT 0,
    "closes" INTEGER NOT NULL DEFAULT 0,
    "media_errors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stat_daily_pkey" PRIMARY KEY ("day","group_id","group_version","slide_id","platform")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_user_subject_key" ON "admin_user"("subject");

-- CreateIndex
CREATE INDEX "story_group_status_idx" ON "story_group"("status");

-- CreateIndex
CREATE INDEX "story_group_placement_start_at_idx" ON "story_group"("placement", "start_at");

-- CreateIndex
CREATE INDEX "story_group_updated_at_idx" ON "story_group"("updated_at");

-- CreateIndex
CREATE INDEX "slide_group_id_position_idx" ON "slide"("group_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_original_key_key" ON "media_asset"("original_key");

-- CreateIndex
CREATE INDEX "media_asset_uploaded_by_created_at_idx" ON "media_asset"("uploaded_by", "created_at");

-- CreateIndex
CREATE INDEX "media_asset_status_created_at_idx" ON "media_asset"("status", "created_at");

-- CreateIndex
CREATE INDEX "published_snapshot_state_start_at_idx" ON "published_snapshot"("state", "start_at");

-- CreateIndex
CREATE INDEX "published_snapshot_state_end_at_idx" ON "published_snapshot"("state", "end_at");

-- CreateIndex
CREATE UNIQUE INDEX "published_snapshot_group_id_version_key" ON "published_snapshot"("group_id", "version");

-- CreateIndex
CREATE INDEX "audit_log_ts_idx" ON "audit_log"("ts");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_ts_idx" ON "audit_log"("entity_type", "entity_id", "ts");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_ts_idx" ON "audit_log"("actor_id", "ts");

-- CreateIndex
CREATE INDEX "story_event_received_at_idx" ON "story_event"("received_at");

-- CreateIndex
CREATE INDEX "story_event_group_id_ts_idx" ON "story_event"("group_id", "ts");

-- CreateIndex
CREATE INDEX "stat_daily_group_id_day_idx" ON "stat_daily"("group_id", "day");

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_fkey" FOREIGN KEY ("role") REFERENCES "role"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_group" ADD CONSTRAINT "story_group_cover_asset_id_fkey" FOREIGN KEY ("cover_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide" ADD CONSTRAINT "slide_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "story_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide" ADD CONSTRAINT "slide_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_snapshot" ADD CONSTRAINT "published_snapshot_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "story_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Защиты уровня БД (не описываются Prisma-схемой)
-- ============================================================================

-- Журнал аудита append-only (раздел 10.9). Роли приложения UPDATE/DELETE отозваны
-- (packages/db/src/grants.ts), а триггер запрещает изменения даже владельцу схемы.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Согласованный снимок неизменяем: меняются только поля жизненного цикла,
-- а состояние движется только вперёд: approved -> published|superseded|archived,
-- published -> superseded|archived. Удалять снимки нельзя.
CREATE OR REPLACE FUNCTION published_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published_snapshot rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.group_id <> OLD.group_id OR NEW.version <> OLD.version
     OR NEW.payload::text <> OLD.payload::text OR NEW.source::text <> OLD.source::text
     OR NEW.placement <> OLD.placement OR NEW.priority <> OLD.priority
     OR NEW.start_at <> OLD.start_at OR NEW.end_at <> OLD.end_at
     OR NEW.platforms <> OLD.platforms
     OR NEW.min_app_version_ios IS DISTINCT FROM OLD.min_app_version_ios
     OR NEW.min_app_version_android IS DISTINCT FROM OLD.min_app_version_android
     OR NEW.segment_ids <> OLD.segment_ids OR NEW.media_asset_ids <> OLD.media_asset_ids
     OR NEW.source_revision <> OLD.source_revision
     OR NEW.approved_by <> OLD.approved_by OR NEW.approved_at <> OLD.approved_at THEN
    RAISE EXCEPTION 'approved snapshot content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'approved' AND NEW.state IN ('published', 'superseded', 'archived'))
    OR (OLD.state = 'published' AND NEW.state IN ('superseded', 'archived'))
  ) THEN
    RAISE EXCEPTION 'invalid snapshot state transition % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER published_snapshot_guard
  BEFORE UPDATE OR DELETE ON "published_snapshot"
  FOR EACH ROW EXECUTE FUNCTION published_snapshot_guard();

-- Не больше одного опубликованного и одного ожидающего публикации снимка на группу.
CREATE UNIQUE INDEX "published_snapshot_one_published"
  ON "published_snapshot" ("group_id") WHERE "state" = 'published';
CREATE UNIQUE INDEX "published_snapshot_one_pending"
  ON "published_snapshot" ("group_id") WHERE "state" = 'approved';

-- Базовые проверки инвариантов рабочей копии.
ALTER TABLE "story_group" ADD CONSTRAINT "story_group_period_check" CHECK ("end_at" > "start_at");
ALTER TABLE "story_group" ADD CONSTRAINT "story_group_title_check" CHECK (char_length("title") BETWEEN 1 AND 40);
ALTER TABLE "published_snapshot" ADD CONSTRAINT "published_snapshot_period_check" CHECK ("end_at" > "start_at");
ALTER TABLE "slide" ADD CONSTRAINT "slide_duration_check" CHECK ("duration_ms" BETWEEN 1 AND 60000);

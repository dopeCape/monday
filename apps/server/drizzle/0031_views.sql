-- Views generalize Boards (ADR 0016, docs/spec/views.md). Every row is kept:
-- the tables and their constraints are renamed, the documents stay sealed
-- under their content kind (read as Views by code), the feed's and the
-- Signal store's owner kind follow, and the Settings move to views.*.
ALTER TABLE "boards" RENAME TO "views";--> statement-breakpoint
ALTER TABLE "board_versions" RENAME TO "view_versions";--> statement-breakpoint
ALTER TABLE "board_drafts" RENAME TO "view_drafts";--> statement-breakpoint
ALTER TABLE "view_versions" RENAME COLUMN "board_id" TO "view_id";--> statement-breakpoint
ALTER TABLE "view_drafts" RENAME COLUMN "board_id" TO "view_id";--> statement-breakpoint
ALTER TABLE "views" RENAME CONSTRAINT "boards_pkey" TO "views_pkey";--> statement-breakpoint
ALTER TABLE "view_versions" RENAME CONSTRAINT "board_versions_pkey" TO "view_versions_pkey";--> statement-breakpoint
ALTER TABLE "view_drafts" RENAME CONSTRAINT "board_drafts_pkey" TO "view_drafts_pkey";--> statement-breakpoint
ALTER TABLE "views" RENAME CONSTRAINT "boards_workspace_id_workspaces_id_fk" TO "views_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "view_versions" RENAME CONSTRAINT "board_versions_board_id_boards_id_fk" TO "view_versions_view_id_views_id_fk";--> statement-breakpoint
ALTER TABLE "view_versions" RENAME CONSTRAINT "board_versions_workspace_id_workspaces_id_fk" TO "view_versions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "view_drafts" RENAME CONSTRAINT "board_drafts_workspace_id_workspaces_id_fk" TO "view_drafts_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "boards_workspace_idx" RENAME TO "views_workspace_idx";--> statement-breakpoint
ALTER INDEX "board_versions_board_version_idx" RENAME TO "view_versions_view_version_idx";--> statement-breakpoint
ALTER INDEX "board_drafts_workspace_idx" RENAME TO "view_drafts_workspace_idx";--> statement-breakpoint
UPDATE "changes" SET "kind" = 'view' WHERE "kind" = 'board';--> statement-breakpoint
UPDATE "signal_defs" SET "owner_kind" = 'view' WHERE "owner_kind" = 'board';--> statement-breakpoint
UPDATE "signal_defs" SET "owners" = (
  SELECT coalesce(jsonb_agg(CASE WHEN o->>'kind' = 'board' THEN jsonb_set(o, '{kind}', '"view"') ELSE o END), '[]'::jsonb)
  FROM jsonb_array_elements("owners") o
) WHERE "owners"::text LIKE '%"board"%';--> statement-breakpoint
UPDATE "settings" SET "key" = 'views.' || substr("key", length('boards.') + 1)
  WHERE "key" LIKE 'boards.%';--> statement-breakpoint
UPDATE "settings" SET "key" = 'strings.views.' || substr("key", length('strings.boards.') + 1)
  WHERE "key" LIKE 'strings.boards.%';

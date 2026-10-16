ALTER TABLE "user_settings" ALTER COLUMN "typography_preset" SET DEFAULT 'style';--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "image_quality" SET DEFAULT 91;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "style_version" integer;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "is_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "phash" text;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "qa" jsonb;--> statement-breakpoint
ALTER TABLE "pin_batches" ADD COLUMN "image_style" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
UPDATE "pin_drafts" SET "image_style" = CASE "image_style" WHEN 'dark_cinematic' THEN 'dark_romantic' WHEN 'lonely_silhouette' THEN 'misty_nature' WHEN 'minimal_black' THEN 'minimal_typography' WHEN 'beige_editorial' THEN 'soft_feminine_editorial' WHEN 'soft_romantic' THEN 'soft_feminine_editorial' WHEN 'moody_blue' THEN 'peaceful_ocean' WHEN 'sunset_aesthetic' THEN 'dreamy_sky' ELSE "image_style" END WHERE "image_style" IN ('dark_cinematic','lonely_silhouette','minimal_black','beige_editorial','soft_romantic','moody_blue','sunset_aesthetic');--> statement-breakpoint
UPDATE "user_settings" SET "default_image_style" = CASE "default_image_style" WHEN 'dark_cinematic' THEN 'dark_romantic' WHEN 'lonely_silhouette' THEN 'misty_nature' WHEN 'minimal_black' THEN 'minimal_typography' WHEN 'beige_editorial' THEN 'soft_feminine_editorial' WHEN 'soft_romantic' THEN 'soft_feminine_editorial' WHEN 'moody_blue' THEN 'peaceful_ocean' WHEN 'sunset_aesthetic' THEN 'dreamy_sky' ELSE "default_image_style" END WHERE "default_image_style" IN ('dark_cinematic','lonely_silhouette','minimal_black','beige_editorial','soft_romantic','moody_blue','sunset_aesthetic');
--> statement-breakpoint
UPDATE "user_settings" SET "typography_preset" = 'style' WHERE "typography_preset" = 'elegant_serif';--> statement-breakpoint
UPDATE "user_settings" SET "image_quality" = 91 WHERE "image_quality" < 90 OR "image_quality" > 92;--> statement-breakpoint
UPDATE "user_settings" SET "watermark_enabled" = false;

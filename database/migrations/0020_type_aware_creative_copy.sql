-- PLAN-0038: image/video ads may carry all advertising copy in the artwork.
-- Text ads still require a headline and receive a default CTA in application validation.
ALTER TABLE "ads_creatives" ALTER COLUMN "headline" DROP NOT NULL;
ALTER TABLE "ads_creatives" ALTER COLUMN "cta_text" DROP NOT NULL;
ALTER TABLE "ads_creatives" ALTER COLUMN "cta_text" DROP DEFAULT;

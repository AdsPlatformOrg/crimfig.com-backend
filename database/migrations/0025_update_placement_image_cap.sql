ALTER TABLE ads_placements DROP CONSTRAINT IF EXISTS ads_image_cap;
ALTER TABLE ads_placements ADD CONSTRAINT ads_image_cap CHECK(image_max_bytes BETWEEN 1000 AND 300000);

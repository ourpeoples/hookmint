-- Where an ad will run (tiktok, meta or youtube), chosen in create_ad. Optional: ads made before this column existed have none.
-- Table-level grants and row-level security already cover a new column, so nothing else changes.

ALTER TABLE ads ADD COLUMN platform text CHECK (platform IN ('tiktok', 'meta', 'youtube'));

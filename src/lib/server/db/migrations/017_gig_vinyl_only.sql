-- A gig played from records alone: its crate search offers only releases
-- with a vinyl format. A preference, not part of what makes a gig a gig.
ALTER TABLE playlist ADD COLUMN vinyl_only INTEGER NOT NULL DEFAULT 0;

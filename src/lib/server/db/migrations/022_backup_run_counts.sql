-- What a backup run did, so the panel can say so: copies made, copies moved
-- to a new place in the backup, copies checked, and whether it was a check.
ALTER TABLE backup_run ADD COLUMN files_copied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_run ADD COLUMN files_moved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_run ADD COLUMN files_checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_run ADD COLUMN verify INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  CREATE TYPE meeting_recording_status AS ENUM ('pending', 'available', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS recording_file_id TEXT;
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS recording_status meeting_recording_status NOT NULL DEFAULT 'pending';
ALTER TABLE meeting_reviews ADD COLUMN IF NOT EXISTS recording_checked_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE meeting_reviews ADD CONSTRAINT meeting_recording_consistency CHECK (
    (recording_status = 'available' AND recording_file_id IS NOT NULL AND recording_file_id ~ '^[A-Za-z0-9_-]{10,255}$')
    OR (recording_status <> 'available' AND recording_file_id IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

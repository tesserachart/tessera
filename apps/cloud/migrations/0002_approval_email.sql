-- Whether an approval's email went out. `sending` while the Worker sends it, then `sent` or `failed` (with the mail
-- service's error code); the admin page offers a resend for a failed one.
ALTER TABLE applications ADD COLUMN approval_email TEXT CHECK (approval_email IN ('sending', 'sent', 'failed'));
ALTER TABLE applications ADD COLUMN approval_email_at TEXT;
ALTER TABLE applications ADD COLUMN approval_email_error TEXT;

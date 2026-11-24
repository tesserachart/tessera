UPDATE entitlements SET key = 'early_access' WHERE key = 'beta';
UPDATE checkins SET channel = 'release' WHERE channel = 'beta';

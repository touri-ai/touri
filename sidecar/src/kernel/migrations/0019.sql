ALTER TABLE bots ADD COLUMN browser TEXT NOT NULL DEFAULT 'touri' CHECK(browser IN ('touri','local','machine'));
-- The VM router previously selected the guest browser from machine alone.
UPDATE bots SET browser = 'machine' WHERE machine = 'vm' AND cloud_target = 0;
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '19');

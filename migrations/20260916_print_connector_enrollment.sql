-- Additive; legacy administrative stations retain null app_user_id.
ALTER TABLE warehouse_print_stations
    ADD COLUMN IF NOT EXISTS app_user_id bigint REFERENCES app_users(id) ON DELETE CASCADE;

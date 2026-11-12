begin;

alter table portal_kitting_requests
    add column if not exists fulfillment_location_id bigint references fulfillment_locations(id) on delete set null,
    add column if not exists processing_business_days integer not null default 4,
    add column if not exists earliest_completion_date date,
    add column if not exists holiday_closures_json jsonb not null default '[]'::jsonb;

alter table portal_kitting_requests
    drop constraint if exists portal_kitting_requests_processing_business_days_check;

alter table portal_kitting_requests
    add constraint portal_kitting_requests_processing_business_days_check
    check (processing_business_days > 0);

create index if not exists idx_portal_kitting_requests_warehouse_status
    on portal_kitting_requests (fulfillment_location_id, status, earliest_completion_date);

commit;

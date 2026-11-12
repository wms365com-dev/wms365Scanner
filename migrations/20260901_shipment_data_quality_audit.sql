create table if not exists shipment_data_quality_findings (
    id bigserial primary key,
    finding_key text not null unique,
    rule_code text not null,
    severity text not null default 'MEDIUM',
    status text not null default 'OPEN',
    account_name text not null default '',
    fulfillment_location_id bigint references fulfillment_locations(id) on delete set null,
    entity_type text not null default 'PORTAL_ORDER',
    entity_id bigint,
    entity_ref text not null default '',
    summary text not null default '',
    details text not null default '',
    suggested_action text not null default '',
    evidence jsonb not null default '{}'::jsonb,
    first_detected_at timestamptz not null default now(),
    last_detected_at timestamptz not null default now(),
    last_notified_at timestamptz,
    resolved_at timestamptz,
    resolved_by text not null default '',
    resolution_note text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint shipment_data_quality_findings_severity_check check (severity in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    constraint shipment_data_quality_findings_status_check check (status in ('OPEN', 'RESOLVED', 'IGNORED'))
);

create index if not exists idx_shipment_data_quality_status_detected
    on shipment_data_quality_findings (status, last_detected_at desc);
create index if not exists idx_shipment_data_quality_warehouse_status
    on shipment_data_quality_findings (fulfillment_location_id, status, last_detected_at desc);
create index if not exists idx_shipment_data_quality_account_status
    on shipment_data_quality_findings (account_name, status, last_detected_at desc);

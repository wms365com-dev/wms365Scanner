-- WMS365 platform foundations: warehouse shipments, asynchronous jobs,
-- partner API credentials, and idempotent external writes.

create table if not exists warehouse_shipments (
    id bigserial primary key,
    shipment_code text not null unique,
    order_id bigint not null references portal_orders(id) on delete cascade,
    account_name text not null,
    fulfillment_location_id bigint not null references fulfillment_locations(id) on delete restrict,
    status text not null default 'RELEASED',
    shipment_method text not null default 'LTL_FREIGHT',
    carrier_name text not null default '',
    tracking_reference text not null default '',
    bol_reference text not null default '',
    total_pallets integer not null default 0 check (total_pallets >= 0),
    existing_pallets integer not null default 0 check (existing_pallets >= 0),
    new_pallets integer not null default 0 check (new_pallets >= 0),
    mixed_pallets integer not null default 0 check (mixed_pallets >= 0),
    shipped_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (order_id, fulfillment_location_id),
    constraint warehouse_shipments_status_check
        check (status in ('RELEASED', 'PICKED', 'STAGED', 'SHIPPED', 'CANCELLED'))
);

create table if not exists warehouse_shipment_lines (
    id bigserial primary key,
    shipment_id bigint not null references warehouse_shipments(id) on delete cascade,
    order_line_id bigint not null references portal_order_lines(id) on delete restrict,
    sku text not null,
    ordered_quantity integer not null check (ordered_quantity > 0),
    shipped_quantity integer not null default 0 check (shipped_quantity >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (shipment_id, order_line_id)
);

alter table portal_order_documents
    add column if not exists warehouse_shipment_id bigint references warehouse_shipments(id) on delete set null;

create index if not exists idx_warehouse_shipments_account_status
    on warehouse_shipments (account_name, status, updated_at desc);
create index if not exists idx_warehouse_shipments_order
    on warehouse_shipments (order_id, fulfillment_location_id);
create index if not exists idx_warehouse_shipment_lines_shipment
    on warehouse_shipment_lines (shipment_id, order_line_id);

create table if not exists async_jobs (
    id bigserial primary key,
    job_code text not null unique,
    account_name text not null,
    job_type text not null,
    status text not null default 'QUEUED',
    source_file_name text not null default '',
    source_checksum text not null default '',
    total_rows integer not null default 0 check (total_rows >= 0),
    processed_rows integer not null default 0 check (processed_rows >= 0),
    accepted_rows integer not null default 0 check (accepted_rows >= 0),
    warning_rows integer not null default 0 check (warning_rows >= 0),
    rejected_rows integer not null default 0 check (rejected_rows >= 0),
    attempts integer not null default 0 check (attempts >= 0),
    max_attempts integer not null default 3 check (max_attempts > 0),
    claimed_at timestamptz,
    claimed_by text not null default '',
    next_retry_at timestamptz,
    completed_at timestamptz,
    error_message text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    created_by text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint async_jobs_status_check check (
        status in ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')
    )
);

create table if not exists async_job_rows (
    id bigserial primary key,
    job_id bigint not null references async_jobs(id) on delete cascade,
    row_number integer not null check (row_number > 0),
    status text not null,
    field_name text not null default '',
    message text not null default '',
    suggested_correction text not null default '',
    source_data jsonb not null default '{}'::jsonb,
    result_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (job_id, row_number),
    constraint async_job_rows_status_check check (status in ('PENDING', 'ACCEPTED', 'WARNING', 'REJECTED'))
);

create unique index if not exists idx_async_jobs_source_dedupe
    on async_jobs (account_name, job_type, source_checksum)
    where source_checksum <> '' and status <> 'CANCELLED';
create index if not exists idx_async_jobs_claim
    on async_jobs (status, next_retry_at, created_at);

create table if not exists partner_api_clients (
    id bigserial primary key,
    client_id text not null unique,
    client_secret_hash text not null,
    client_name text not null,
    account_name text not null,
    environment text not null default 'TEST',
    scopes text[] not null default '{}'::text[],
    is_active boolean not null default true,
    created_by text not null default '',
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint partner_api_clients_environment_check check (environment in ('TEST', 'PRODUCTION'))
);

create table if not exists partner_api_tokens (
    id bigserial primary key,
    client_id bigint not null references partner_api_clients(id) on delete cascade,
    token_hash text not null unique,
    token_type text not null,
    scopes text[] not null default '{}'::text[],
    expires_at timestamptz not null,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    constraint partner_api_tokens_type_check check (token_type in ('ACCESS', 'REFRESH'))
);

create table if not exists partner_api_idempotency (
    id bigserial primary key,
    client_id bigint not null references partner_api_clients(id) on delete cascade,
    idempotency_key text not null,
    request_method text not null,
    request_path text not null,
    request_hash text not null,
    response_status integer,
    response_body jsonb,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '24 hours'),
    unique (client_id, idempotency_key)
);

create table if not exists partner_api_audit_log (
    id bigserial primary key,
    client_id bigint references partner_api_clients(id) on delete set null,
    account_name text not null default '',
    request_method text not null default '',
    request_path text not null default '',
    response_status integer,
    request_id text not null default '',
    ip_address text not null default '',
    created_at timestamptz not null default now()
);

create index if not exists idx_partner_api_tokens_client_expiry
    on partner_api_tokens (client_id, expires_at);
create index if not exists idx_partner_api_audit_client_time
    on partner_api_audit_log (client_id, created_at desc);

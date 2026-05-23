create table if not exists pick_confirmations (
    id bigserial primary key,
    order_id bigint not null references portal_orders(id) on delete cascade,
    line_id bigint references portal_order_lines(id) on delete set null,
    worker_id bigint references app_users(id) on delete set null,
    device_id text not null default '',
    location text not null default '',
    sku text not null default '',
    lot text not null default '',
    expiry text not null default '',
    quantity integer not null check (quantity > 0),
    timestamp timestamptz not null default now(),
    sync_status text not null default 'SYNCED',
    idempotency_key text not null,
    source text not null default 'mobile_web',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table pick_confirmations add column if not exists source text not null default 'mobile_web';
alter table pick_confirmations add column if not exists created_at timestamptz not null default now();
alter table pick_confirmations add column if not exists updated_at timestamptz not null default now();
alter table pick_confirmations drop constraint if exists pick_confirmations_sync_status_check;
alter table pick_confirmations add constraint pick_confirmations_sync_status_check check (sync_status in ('PENDING', 'SYNCED', 'FAILED'));
create unique index if not exists idx_pick_confirmations_idempotency on pick_confirmations (idempotency_key);
create index if not exists idx_pick_confirmations_order_line on pick_confirmations (order_id, line_id);
create index if not exists idx_pick_confirmations_worker_time on pick_confirmations (worker_id, timestamp desc);
create index if not exists idx_pick_confirmations_location_sku on pick_confirmations (location, sku);

create table if not exists mobile_execution_confirmations (
    id bigserial primary key,
    confirmation_type text not null,
    source_type text not null default '',
    source_id bigint,
    worker_id bigint references app_users(id) on delete set null,
    device_id text not null default '',
    account_name text not null default '',
    location text not null default '',
    from_location text not null default '',
    to_location text not null default '',
    sku text not null default '',
    lot text not null default '',
    expiry text not null default '',
    quantity integer not null default 0 check (quantity >= 0),
    sync_status text not null default 'SYNCED',
    idempotency_key text not null,
    source text not null default 'mobile_web',
    payload jsonb not null default '{}'::jsonb,
    timestamp timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table mobile_execution_confirmations drop constraint if exists mobile_execution_confirmations_sync_status_check;
alter table mobile_execution_confirmations add constraint mobile_execution_confirmations_sync_status_check check (sync_status in ('PENDING', 'SYNCED', 'FAILED'));
alter table mobile_execution_confirmations drop constraint if exists mobile_execution_confirmations_type_check;
alter table mobile_execution_confirmations add constraint mobile_execution_confirmations_type_check check (confirmation_type in ('PUT_AWAY', 'MOVE', 'RECEIVING'));
create unique index if not exists idx_mobile_execution_confirmations_idempotency on mobile_execution_confirmations (idempotency_key);
create index if not exists idx_mobile_execution_confirmations_source on mobile_execution_confirmations (source_type, source_id, confirmation_type);
create index if not exists idx_mobile_execution_confirmations_worker_time on mobile_execution_confirmations (worker_id, timestamp desc);

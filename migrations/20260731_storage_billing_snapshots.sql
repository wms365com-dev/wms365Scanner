create table if not exists storage_billing_snapshots (
    id bigserial primary key,
    account_name text not null,
    billing_month text not null,
    status text not null default 'DRAFT' check (status in ('DRAFT','REVIEWED','POSTED','VOID')),
    pallet_count integer not null default 0 check (pallet_count >= 0),
    floor_positions integer not null default 0 check (floor_positions >= 0),
    snapshot_data jsonb not null default '{}'::jsonb,
    created_by text not null default '',
    reviewed_by text not null default '',
    reviewed_at timestamptz,
    posted_by text not null default '',
    posted_at timestamptz,
    review_note text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (account_name, billing_month)
);
create index if not exists idx_storage_billing_snapshots_status
    on storage_billing_snapshots (status, billing_month, account_name);

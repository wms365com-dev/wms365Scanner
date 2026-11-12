alter table warehouse_print_stations add column if not exists device_key_thumbprint text;
alter table warehouse_print_stations add column if not exists installation_id uuid;
alter table warehouse_print_stations add column if not exists credential_expires_at timestamptz;
create table if not exists warehouse_print_proof_receipts (
    key_thumbprint text not null,
    proof_id uuid not null,
    expires_at timestamptz not null,
    primary key (key_thumbprint, proof_id)
);
create index if not exists idx_warehouse_print_proof_expiry on warehouse_print_proof_receipts (expires_at);

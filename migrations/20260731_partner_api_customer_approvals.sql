create table if not exists partner_api_approvals (
    id bigserial primary key,
    account_name text not null,
    client_name text not null,
    scopes text[] not null default '{}'::text[],
    status text not null default 'APPROVED',
    approved_by text not null,
    approved_at timestamptz not null default now(),
    consumed_by_client_id bigint references partner_api_clients(id) on delete set null,
    consumed_at timestamptz,
    created_at timestamptz not null default now(),
    constraint partner_api_approvals_status_check check (status in ('APPROVED', 'REVOKED', 'CONSUMED'))
);

create index if not exists idx_partner_api_approvals_account_status
    on partner_api_approvals (account_name, status, created_at desc);

create table if not exists email_delivery_log (
    id bigserial primary key,
    status text not null default 'PENDING',
    provider text not null default '',
    from_address text not null default '',
    to_addresses jsonb not null default '[]'::jsonb,
    cc_addresses jsonb not null default '[]'::jsonb,
    bcc_addresses jsonb not null default '[]'::jsonb,
    reply_to text not null default '',
    subject text not null default '',
    account_name text not null default '',
    source_type text not null default '',
    source_ref text not null default '',
    message_id text not null default '',
    provider_response text not null default '',
    error_message text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    failed_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint email_delivery_log_status_check check (status in ('PENDING', 'SENT', 'FAILED'))
);

alter table email_delivery_log add column if not exists status text not null default 'PENDING';
alter table email_delivery_log add column if not exists provider text not null default '';
alter table email_delivery_log add column if not exists from_address text not null default '';
alter table email_delivery_log add column if not exists to_addresses jsonb not null default '[]'::jsonb;
alter table email_delivery_log add column if not exists cc_addresses jsonb not null default '[]'::jsonb;
alter table email_delivery_log add column if not exists bcc_addresses jsonb not null default '[]'::jsonb;
alter table email_delivery_log add column if not exists reply_to text not null default '';
alter table email_delivery_log add column if not exists subject text not null default '';
alter table email_delivery_log add column if not exists account_name text not null default '';
alter table email_delivery_log add column if not exists source_type text not null default '';
alter table email_delivery_log add column if not exists source_ref text not null default '';
alter table email_delivery_log add column if not exists message_id text not null default '';
alter table email_delivery_log add column if not exists provider_response text not null default '';
alter table email_delivery_log add column if not exists error_message text not null default '';
alter table email_delivery_log add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table email_delivery_log add column if not exists sent_at timestamptz;
alter table email_delivery_log add column if not exists failed_at timestamptz;
alter table email_delivery_log add column if not exists updated_at timestamptz not null default now();

alter table email_delivery_log drop constraint if exists email_delivery_log_status_check;
alter table email_delivery_log add constraint email_delivery_log_status_check check (status in ('PENDING', 'SENT', 'FAILED'));

create index if not exists idx_email_delivery_log_created_at on email_delivery_log (created_at desc);
create index if not exists idx_email_delivery_log_status_created on email_delivery_log (status, created_at desc);
create index if not exists idx_email_delivery_log_account_created on email_delivery_log (account_name, created_at desc);

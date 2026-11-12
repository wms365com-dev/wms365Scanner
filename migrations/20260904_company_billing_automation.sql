create table if not exists company_billing_automation_policies (
    account_name text primary key,
    is_enabled boolean not null default false,
    effective_from date not null,
    notify_on_inbound_received boolean not null default true,
    notify_on_order_shipped boolean not null default true,
    include_source_documents boolean not null default true,
    include_system_documents boolean not null default true,
    charge_initial_storage_on_receipt boolean not null default false,
    billing_recipient_email text not null default '',
    note text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_company_billing_automation_enabled
    on company_billing_automation_policies (is_enabled, effective_from);

insert into company_billing_automation_policies (
    account_name, is_enabled, effective_from, notify_on_inbound_received,
    notify_on_order_shipped, include_source_documents, include_system_documents,
    charge_initial_storage_on_receipt, billing_recipient_email, note
) values (
    'ALCONA TRADING LTD', true, date '2026-09-01', true, true, true, true, true, '',
    'Initial controlled billing automation rollout. Rates remain company-configured.'
)
on conflict (account_name) do nothing;

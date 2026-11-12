-- WMS365 Billing & Accounting Phase 1.
-- Adds tenant/master-customer ownership, sub-customer portal invoice visibility,
-- invoice attachments/logs, discounts, and vendor/expense ownership fields.

create table if not exists master_customers (
    id bigserial primary key,
    name text not null unique,
    legal_name text not null default '',
    billing_email text not null default '',
    phone text not null default '',
    address text not null default '',
    logo_url text not null default '',
    payment_instructions text not null default '',
    currency text not null default 'CAD',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

insert into master_customers (name, legal_name, currency, is_active)
values ('WMS365 MASTER COMPANY', 'WMS365 MASTER COMPANY', 'CAD', true)
on conflict (name) do nothing;

create table if not exists warehouses (
    id bigserial primary key,
    master_customer_id bigint references master_customers(id) on delete set null,
    code text not null unique,
    name text not null,
    source_fulfillment_location_id bigint,
    address text not null default '',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists sub_customers (
    id bigserial primary key,
    master_customer_id bigint references master_customers(id) on delete cascade,
    account_name text not null,
    customer_name text not null,
    source_owner_account_id bigint,
    billing_email text not null default '',
    portal_email text not null default '',
    payment_terms text not null default 'Net 30',
    currency text not null default 'CAD',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (master_customer_id, account_name)
);

insert into warehouses (master_customer_id, code, name, source_fulfillment_location_id, address, is_active)
select
    (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1),
    fl.code,
    fl.name,
    fl.id,
    concat_ws(', ', nullif(fl.address1, ''), nullif(fl.address2, ''), nullif(fl.city, ''), nullif(fl.state, ''), nullif(fl.postal_code, ''), nullif(fl.country, '')),
    coalesce(fl.is_active, true)
from fulfillment_locations fl
where trim(coalesce(fl.code, '')) <> ''
on conflict (code) do update set
    name = excluded.name,
    source_fulfillment_location_id = excluded.source_fulfillment_location_id,
    address = excluded.address,
    is_active = excluded.is_active,
    updated_at = now();

insert into sub_customers (master_customer_id, account_name, customer_name, source_owner_account_id, billing_email, portal_email, payment_terms, currency, is_active)
select
    (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1),
    o.name,
    coalesce(nullif(o.legal_name, ''), o.name),
    o.id,
    coalesce(nullif(o.billing_email, ''), nullif(o.ap_email, ''), nullif(o.email, ''), ''),
    coalesce(nullif(o.portal_login_email, ''), ''),
    'Net 30',
    'CAD',
    coalesce(o.is_active, true)
from owner_accounts o
where trim(coalesce(o.name, '')) <> ''
on conflict (master_customer_id, account_name) do update set
    customer_name = excluded.customer_name,
    source_owner_account_id = excluded.source_owner_account_id,
    billing_email = excluded.billing_email,
    portal_email = excluded.portal_email,
    is_active = excluded.is_active,
    updated_at = now();

alter table billing_events add column if not exists master_customer_id bigint;
alter table billing_events add column if not exists master_customer_name text not null default '';
alter table billing_events add column if not exists sub_customer_id bigint;
alter table billing_events add column if not exists sub_customer_name text not null default '';

alter table invoices add column if not exists master_customer_id bigint;
alter table invoices add column if not exists master_customer_name text not null default '';
alter table invoices add column if not exists sub_customer_id bigint;
alter table invoices add column if not exists sub_customer_name text not null default '';
alter table invoices add column if not exists warehouse_id text not null default '';
alter table invoices add column if not exists discount_amount numeric(12, 2) not null default 0;
alter table invoices add column if not exists payment_instructions text not null default '';
alter table invoices add column if not exists email_status text not null default '';
alter table invoices add column if not exists last_emailed_at timestamptz;

alter table invoice_lines add column if not exists discount_amount numeric(12, 2) not null default 0;

create table if not exists invoice_attachments (
    id bigserial primary key,
    invoice_id bigint not null references invoices(id) on delete cascade,
    file_name text not null default '',
    mime_type text not null default '',
    file_data text not null default '',
    source_type text not null default 'upload',
    source_reference text not null default '',
    notes text not null default '',
    created_by text not null default '',
    created_at timestamptz not null default now()
);

create table if not exists invoice_email_logs (
    id bigserial primary key,
    invoice_id bigint references invoices(id) on delete set null,
    customer_id text not null default '',
    to_email text not null default '',
    subject text not null default '',
    body text not null default '',
    provider text not null default 'draft',
    status text not null default 'draft',
    error_message text not null default '',
    created_by text not null default '',
    created_at timestamptz not null default now()
);

alter table payments add column if not exists master_customer_id bigint;
alter table payments add column if not exists master_customer_name text not null default '';
alter table payments add column if not exists sub_customer_id bigint;
alter table payments add column if not exists sub_customer_name text not null default '';

alter table vendors add column if not exists master_customer_id bigint;
alter table vendors add column if not exists master_customer_name text not null default '';
alter table vendor_bills add column if not exists master_customer_id bigint;
alter table vendor_bills add column if not exists master_customer_name text not null default '';
alter table vendor_bills add column if not exists warehouse_id text not null default '';
alter table vendor_bills add column if not exists category text not null default 'Miscellaneous';
alter table vendor_bills add column if not exists tax_amount numeric(12, 2) not null default 0;
alter table vendor_bills add column if not exists attachment_upload text not null default '';
alter table vendor_payments add column if not exists master_customer_id bigint;
alter table vendor_payments add column if not exists master_customer_name text not null default '';

alter table expenses add column if not exists master_customer_id bigint;
alter table expenses add column if not exists master_customer_name text not null default '';
alter table expenses add column if not exists is_recurring boolean not null default false;
alter table expenses add column if not exists recurrence_rule text not null default '';

alter table journal_entries add column if not exists master_customer_id bigint;
alter table journal_entries add column if not exists master_customer_name text not null default '';
alter table audit_logs add column if not exists master_customer_id bigint;
alter table audit_logs add column if not exists master_customer_name text not null default '';

with scoped as (
    select
        be.id as billing_event_id,
        mc.id as master_customer_id,
        mc.name as master_customer_name,
        sc.id as sub_customer_id,
        coalesce(nullif(be.customer_id, ''), be.account_name) as sub_customer_name
    from billing_events be
    cross join master_customers mc
    left join sub_customers sc
      on sc.master_customer_id = mc.id
     and sc.account_name = coalesce(nullif(be.customer_id, ''), be.account_name)
    where mc.name = 'WMS365 MASTER COMPANY'
)
update billing_events be
set
    master_customer_id = coalesce(be.master_customer_id, scoped.master_customer_id),
    master_customer_name = case when be.master_customer_name = '' then scoped.master_customer_name else be.master_customer_name end,
    sub_customer_id = coalesce(be.sub_customer_id, scoped.sub_customer_id),
    sub_customer_name = case when be.sub_customer_name = '' then scoped.sub_customer_name else be.sub_customer_name end
from scoped
where be.id = scoped.billing_event_id;

with scoped as (
    select
        i.id as invoice_id,
        mc.id as master_customer_id,
        mc.name as master_customer_name,
        sc.id as sub_customer_id,
        i.customer_id as sub_customer_name
    from invoices i
    cross join master_customers mc
    left join sub_customers sc
      on sc.master_customer_id = mc.id
     and sc.account_name = i.customer_id
    where mc.name = 'WMS365 MASTER COMPANY'
)
update invoices i
set
    master_customer_id = coalesce(i.master_customer_id, scoped.master_customer_id),
    master_customer_name = case when i.master_customer_name = '' then scoped.master_customer_name else i.master_customer_name end,
    sub_customer_id = coalesce(i.sub_customer_id, scoped.sub_customer_id),
    sub_customer_name = case when i.sub_customer_name = '' then scoped.sub_customer_name else i.sub_customer_name end
from scoped
where i.id = scoped.invoice_id;

with scoped as (
    select
        p.id as payment_id,
        mc.id as master_customer_id,
        mc.name as master_customer_name,
        sc.id as sub_customer_id,
        p.customer_id as sub_customer_name
    from payments p
    cross join master_customers mc
    left join sub_customers sc
      on sc.master_customer_id = mc.id
     and sc.account_name = p.customer_id
    where mc.name = 'WMS365 MASTER COMPANY'
)
update payments p
set
    master_customer_id = coalesce(p.master_customer_id, scoped.master_customer_id),
    master_customer_name = case when p.master_customer_name = '' then scoped.master_customer_name else p.master_customer_name end,
    sub_customer_id = coalesce(p.sub_customer_id, scoped.sub_customer_id),
    sub_customer_name = case when p.sub_customer_name = '' then scoped.sub_customer_name else p.sub_customer_name end
from scoped
where p.id = scoped.payment_id;

update vendors set master_customer_id = coalesce(master_customer_id, (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1)), master_customer_name = case when master_customer_name = '' then 'WMS365 MASTER COMPANY' else master_customer_name end;
update vendor_bills set master_customer_id = coalesce(master_customer_id, (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1)), master_customer_name = case when master_customer_name = '' then 'WMS365 MASTER COMPANY' else master_customer_name end;
update vendor_payments set master_customer_id = coalesce(master_customer_id, (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1)), master_customer_name = case when master_customer_name = '' then 'WMS365 MASTER COMPANY' else master_customer_name end;
update expenses set master_customer_id = coalesce(master_customer_id, (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1)), master_customer_name = case when master_customer_name = '' then 'WMS365 MASTER COMPANY' else master_customer_name end;
update journal_entries set master_customer_id = coalesce(master_customer_id, (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1)), master_customer_name = case when master_customer_name = '' then 'WMS365 MASTER COMPANY' else master_customer_name end;
update audit_logs set master_customer_id = coalesce(master_customer_id, (select id from master_customers where name = 'WMS365 MASTER COMPANY' limit 1)), master_customer_name = case when master_customer_name = '' then 'WMS365 MASTER COMPANY' else master_customer_name end;

create index if not exists idx_sub_customers_master_account on sub_customers (master_customer_id, account_name);
create index if not exists idx_warehouses_master_code on warehouses (master_customer_id, code);
create index if not exists idx_invoices_master_customer on invoices (master_customer_id, customer_id, invoice_date desc);
create index if not exists idx_expenses_master_customer on expenses (master_customer_id, expense_date desc);
create index if not exists idx_billing_events_master_customer on billing_events (master_customer_id, customer_id, activity_date desc);
create index if not exists idx_invoice_attachments_invoice on invoice_attachments (invoice_id);

-- WMS365 Billing & Finance base schema.
-- This migration creates the standalone finance module tables without exposing secrets.

alter table billing_events add column if not exists customer_id text not null default '';
alter table billing_events add column if not exists warehouse_id text not null default '';
alter table billing_events add column if not exists activity_date date;
update billing_events set activity_date = service_date where activity_date is null;
alter table billing_events add column if not exists source_module text not null default '';
alter table billing_events add column if not exists source_reference text not null default '';
alter table billing_events add column if not exists activity_type text not null default '';
alter table billing_events add column if not exists charge_type text not null default '';
alter table billing_events add column if not exists description text not null default '';
alter table billing_events add column if not exists unit_rate numeric(12, 4);
update billing_events set unit_rate = rate where unit_rate is null;
alter table billing_events add column if not exists tax_code text not null default 'HST_ON';
alter table billing_events add column if not exists invoice_id bigint;
alter table billing_events add column if not exists created_by text not null default '';
alter table billing_events add column if not exists notes text not null default '';
update billing_events set customer_id = account_name where customer_id = '';
update billing_events set source_module = source_type where source_module = '' and source_type <> '';
update billing_events set source_reference = source_ref where source_reference = '' and source_ref <> '';
update billing_events set charge_type = fee_code where charge_type = '';
update billing_events set description = fee_name where description = '';
update billing_events set notes = note where notes = '' and note <> '';
alter table billing_events drop constraint if exists billing_events_status_check;
alter table billing_events add constraint billing_events_status_check
    check (status in ('OPEN', 'INVOICED', 'VOID', 'pending', 'approved', 'invoiced', 'voided'));

create table if not exists customer_billing_profiles (
    id bigserial primary key,
    account_name text not null unique,
    customer_name text not null,
    billing_contact text not null default '',
    email text not null default '',
    phone text not null default '',
    billing_address text not null default '',
    payment_terms text not null default 'Net 30',
    currency text not null default 'CAD',
    tax_settings jsonb not null default '{}'::jsonb,
    assigned_rate_card_id bigint,
    billing_cycle text not null default 'Monthly',
    minimum_monthly_billing numeric(12, 2) not null default 0,
    credit_limit numeric(12, 2) not null default 0,
    notes text not null default '',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists rate_cards (
    id bigserial primary key,
    name text not null unique,
    description text not null default '',
    currency text not null default 'CAD',
    effective_from date,
    effective_to date,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists rate_card_lines (
    id bigserial primary key,
    rate_card_id bigint not null references rate_cards(id) on delete cascade,
    charge_type text not null,
    unit text not null,
    rate numeric(12, 4) not null default 0,
    tax_code text not null default 'HST_ON',
    customer_id text not null default '',
    effective_from date,
    effective_to date,
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (rate_card_id, charge_type, customer_id, effective_from)
);

create table if not exists rate_card_history (
    id bigserial primary key,
    rate_card_id bigint,
    rate_card_line_id bigint,
    change_type text not null default 'updated',
    previous_values jsonb not null default '{}'::jsonb,
    new_values jsonb not null default '{}'::jsonb,
    changed_by text not null default '',
    changed_at timestamptz not null default now()
);

create table if not exists invoices (
    id bigserial primary key,
    invoice_number text not null unique,
    customer_id text not null,
    billing_address text not null default '',
    invoice_date date not null default current_date,
    due_date date not null default current_date,
    payment_terms text not null default 'Net 30',
    currency text not null default 'CAD',
    subtotal numeric(12, 2) not null default 0,
    tax numeric(12, 2) not null default 0,
    total numeric(12, 2) not null default 0,
    paid_amount numeric(12, 2) not null default 0,
    balance_due numeric(12, 2) not null default 0,
    notes text not null default '',
    status text not null default 'draft',
    is_recurring boolean not null default false,
    recurrence_rule text not null default '',
    sent_at timestamptz,
    paid_at timestamptz,
    voided_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table billing_events drop constraint if exists billing_events_invoice_id_fkey;
alter table billing_events add constraint billing_events_invoice_id_fkey
    foreign key (invoice_id) references invoices(id) on delete set null;

create table if not exists invoice_lines (
    id bigserial primary key,
    invoice_id bigint not null references invoices(id) on delete cascade,
    billing_event_id bigint,
    line_number integer not null default 1,
    description text not null,
    charge_type text not null default '',
    quantity numeric(12, 4) not null default 1,
    unit_rate numeric(12, 4) not null default 0,
    tax_code text not null default 'HST_ON',
    tax_amount numeric(12, 2) not null default 0,
    amount numeric(12, 2) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists payments (
    id bigserial primary key,
    payment_date date not null default current_date,
    customer_id text not null,
    invoice_reference text not null default '',
    amount numeric(12, 2) not null default 0,
    payment_method text not null default 'EFT',
    reference_number text not null default '',
    notes text not null default '',
    unapplied_amount numeric(12, 2) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists payment_allocations (
    id bigserial primary key,
    payment_id bigint not null references payments(id) on delete cascade,
    invoice_id bigint references invoices(id) on delete set null,
    amount numeric(12, 2) not null default 0,
    created_at timestamptz not null default now()
);

create table if not exists credit_notes (
    id bigserial primary key,
    credit_note_number text not null unique,
    customer_id text not null,
    invoice_id bigint references invoices(id) on delete set null,
    credit_date date not null default current_date,
    amount numeric(12, 2) not null default 0,
    tax_amount numeric(12, 2) not null default 0,
    status text not null default 'open',
    reason text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists vendors (
    id bigserial primary key,
    vendor_name text not null unique,
    contact_name text not null default '',
    email text not null default '',
    phone text not null default '',
    address text not null default '',
    tax_number text not null default '',
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists vendor_bills (
    id bigserial primary key,
    vendor_id bigint references vendors(id) on delete set null,
    bill_number text not null default '',
    bill_date date not null default current_date,
    due_date date,
    amount numeric(12, 2) not null default 0,
    paid_amount numeric(12, 2) not null default 0,
    status text not null default 'open',
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists vendor_payments (
    id bigserial primary key,
    vendor_id bigint references vendors(id) on delete set null,
    vendor_bill_id bigint references vendor_bills(id) on delete set null,
    payment_date date not null default current_date,
    amount numeric(12, 2) not null default 0,
    payment_method text not null default 'EFT',
    reference_number text not null default '',
    notes text not null default '',
    created_at timestamptz not null default now()
);

create table if not exists expense_categories (
    id bigserial primary key,
    name text not null unique,
    account_code text not null default '5000',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists expenses (
    id bigserial primary key,
    vendor_id bigint references vendors(id) on delete set null,
    vendor text not null default '',
    expense_category text not null default 'Miscellaneous',
    expense_date date not null default current_date,
    description text not null default '',
    amount_before_tax numeric(12, 2) not null default 0,
    tax_amount numeric(12, 2) not null default 0,
    total_amount numeric(12, 2) not null default 0,
    payment_status text not null default 'unpaid',
    payment_method text not null default '',
    receipt_upload text not null default '',
    billable boolean not null default false,
    customer_reference text not null default '',
    warehouse_reference text not null default '',
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists expense_attachments (
    id bigserial primary key,
    expense_id bigint not null references expenses(id) on delete cascade,
    file_name text not null default '',
    mime_type text not null default '',
    file_data text not null default '',
    created_at timestamptz not null default now()
);

create table if not exists bank_accounts (
    id bigserial primary key,
    account_name text not null unique,
    bank_name text not null default '',
    account_number text not null default '',
    currency text not null default 'CAD',
    opening_balance numeric(12, 2) not null default 0,
    current_balance numeric(12, 2) not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists bank_transactions (
    id bigserial primary key,
    bank_account_id bigint references bank_accounts(id) on delete cascade,
    transaction_date date not null default current_date,
    transaction_type text not null default 'deposit',
    description text not null default '',
    amount numeric(12, 2) not null default 0,
    matched_type text not null default '',
    matched_id bigint,
    reconciliation_id bigint,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists bank_reconciliations (
    id bigserial primary key,
    bank_account_id bigint references bank_accounts(id) on delete cascade,
    statement_date date not null default current_date,
    statement_balance numeric(12, 2) not null default 0,
    reconciled_balance numeric(12, 2) not null default 0,
    status text not null default 'draft',
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists chart_of_accounts (
    id bigserial primary key,
    account_code text not null unique,
    account_name text not null,
    account_type text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists journal_entries (
    id bigserial primary key,
    entry_number text not null unique,
    entry_date date not null default current_date,
    source_type text not null default 'manual',
    source_id bigint,
    memo text not null default '',
    created_by text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists journal_entry_lines (
    id bigserial primary key,
    journal_entry_id bigint not null references journal_entries(id) on delete cascade,
    account_code text not null,
    description text not null default '',
    debit numeric(12, 2) not null default 0,
    credit numeric(12, 2) not null default 0,
    created_at timestamptz not null default now()
);

create table if not exists tax_codes (
    id bigserial primary key,
    code text not null unique,
    name text not null,
    rate numeric(8, 4) not null default 0,
    province text not null default '',
    recoverable boolean not null default true,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
    id bigserial primary key,
    module text not null default 'billing_finance',
    entity_type text not null default '',
    entity_id text not null default '',
    action text not null default '',
    actor_email text not null default '',
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

insert into chart_of_accounts (account_code, account_name, account_type)
values
    ('1000', 'Cash', 'Assets'),
    ('1100', 'Accounts Receivable', 'Assets'),
    ('1200', 'Tax Recoverable', 'Assets'),
    ('2000', 'Accounts Payable', 'Liabilities'),
    ('2100', 'Tax Payable', 'Liabilities'),
    ('3000', 'Owner Equity', 'Equity'),
    ('4000', 'Warehouse Revenue', 'Revenue'),
    ('4010', 'Storage Revenue', 'Revenue'),
    ('4020', 'Pick Pack Revenue', 'Revenue'),
    ('4030', 'Freight Revenue', 'Revenue'),
    ('5000', 'Warehouse Expenses', 'Expenses'),
    ('5010', 'Labour Expense', 'Expenses'),
    ('5020', 'Freight Expense', 'Expenses'),
    ('5030', 'Rent Expense', 'Expenses'),
    ('5040', 'Supplies Expense', 'Expenses')
on conflict (account_code) do update set
    account_name = excluded.account_name,
    account_type = excluded.account_type,
    is_active = true,
    updated_at = now();

insert into tax_codes (code, name, rate, province, recoverable, is_active)
values
    ('HST_ON', 'HST Ontario', 13, 'ON', true, true),
    ('GST', 'GST', 5, '', true, true),
    ('PST_BC', 'PST British Columbia', 7, 'BC', true, true),
    ('PST_SK', 'PST Saskatchewan', 6, 'SK', true, true),
    ('PST_MB', 'RST Manitoba', 7, 'MB', true, true),
    ('EXEMPT', 'Exempt', 0, '', false, true)
on conflict (code) do update set
    name = excluded.name,
    rate = excluded.rate,
    province = excluded.province,
    recoverable = excluded.recoverable,
    is_active = true,
    updated_at = now();

insert into rate_cards (name, description, currency, effective_from, is_active)
values ('Standard 3PL Rate Card', 'Default warehouse billing rates for 3PL operations.', 'CAD', current_date, true)
on conflict (name) do nothing;

insert into bank_accounts (account_name, bank_name, currency, opening_balance, current_balance)
values ('Operating Account', 'Default Bank', 'CAD', 0, 0)
on conflict (account_name) do nothing;

create index if not exists idx_billing_finance_customer_profiles_account on customer_billing_profiles (account_name);
create index if not exists idx_rate_card_lines_card on rate_card_lines (rate_card_id);
create index if not exists idx_invoices_customer_status on invoices (customer_id, status, due_date);
create index if not exists idx_invoice_lines_invoice on invoice_lines (invoice_id);
create index if not exists idx_payments_customer on payments (customer_id, payment_date desc);
create index if not exists idx_expenses_category_date on expenses (expense_category, expense_date desc);
create index if not exists idx_journal_entry_lines_account on journal_entry_lines (account_code);

-- WMS365 Billing & Finance accounting controls.
-- Apply after the base Billing & Finance schema exists.

create table if not exists billing_finance_document_sequences (
    document_type text primary key,
    prefix text not null,
    next_number integer not null default 1,
    number_padding integer not null default 6,
    reset_policy text not null default 'never',
    updated_by text not null default '',
    updated_at timestamptz not null default now()
);

insert into billing_finance_document_sequences (document_type, prefix, next_number, number_padding)
values
    ('invoice', 'INV', 1, 6),
    ('journal_entry', 'JE', 1, 6),
    ('credit_note', 'CN', 1, 6)
on conflict (document_type) do nothing;

alter table invoices add column if not exists posting_status text not null default 'unposted';
alter table invoices add column if not exists posted_at timestamptz;
alter table invoices add column if not exists posted_journal_entry_id bigint;
alter table invoices add column if not exists locked_at timestamptz;
alter table invoices add column if not exists locked_by text not null default '';

alter table journal_entries add column if not exists is_posted boolean not null default true;
alter table journal_entries add column if not exists posted_at timestamptz not null default now();
alter table journal_entries add column if not exists locked_at timestamptz not null default now();
alter table journal_entries add column if not exists reversed_entry_id bigint;
alter table journal_entries add column if not exists reversal_entry_id bigint;
alter table journal_entries add column if not exists is_reversal boolean not null default false;

insert into chart_of_accounts (account_code, account_name, account_type)
values ('2200', 'Customer Credits', 'Liabilities')
on conflict (account_code) do update set
    account_name = excluded.account_name,
    account_type = excluded.account_type,
    is_active = true,
    updated_at = now();

alter table invoices drop constraint if exists invoices_posted_journal_entry_id_fkey;
alter table invoices add constraint invoices_posted_journal_entry_id_fkey
    foreign key (posted_journal_entry_id) references journal_entries(id) on delete set null;

create index if not exists idx_payment_allocations_invoice on payment_allocations (invoice_id);

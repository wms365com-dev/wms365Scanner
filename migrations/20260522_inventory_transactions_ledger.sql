create table if not exists inventory_transactions (
    id bigserial primary key,
    account_name text not null,
    warehouse_id text not null default '',
    fulfillment_location_id bigint,
    location text not null default '',
    sku text not null default '',
    upc text not null default '',
    lot_number text not null default '',
    expiration_date text not null default '',
    transaction_type text not null,
    quantity_delta integer not null,
    quantity_before integer not null check (quantity_before >= 0),
    quantity_after integer not null check (quantity_after >= 0),
    source_type text not null default '',
    source_id text not null default '',
    user_id bigint,
    device_id text not null default '',
    source text not null default '',
    client_timestamp timestamptz,
    server_timestamp timestamptz not null default now()
);

alter table inventory_transactions add column if not exists warehouse_id text not null default '';
alter table inventory_transactions add column if not exists fulfillment_location_id bigint;
alter table inventory_transactions drop constraint if exists inventory_transactions_fulfillment_location_id_fkey;
alter table inventory_transactions drop constraint if exists inventory_transactions_user_id_fkey;
alter table inventory_transactions add column if not exists device_id text not null default '';
alter table inventory_transactions add column if not exists source text not null default '';
alter table inventory_transactions add column if not exists client_timestamp timestamptz;
alter table inventory_transactions add column if not exists server_timestamp timestamptz not null default now();

create or replace function prevent_inventory_transactions_mutation()
returns trigger as $$
begin
    if current_setting('wms365.allow_inventory_transaction_archive', true) = 'on' then
        if tg_op = 'UPDATE' then
            return new;
        end if;
        return old;
    end if;
    raise exception 'inventory_transactions is append-only';
end;
$$ language plpgsql;

drop trigger if exists inventory_transactions_append_only on inventory_transactions;
create trigger inventory_transactions_append_only
before update or delete on inventory_transactions
for each row execute function prevent_inventory_transactions_mutation();

create index if not exists idx_inventory_transactions_account_time on inventory_transactions (account_name, server_timestamp desc);
create index if not exists idx_inventory_transactions_location on inventory_transactions (account_name, location, server_timestamp desc);
create index if not exists idx_inventory_transactions_sku on inventory_transactions (account_name, sku, server_timestamp desc);
create index if not exists idx_inventory_transactions_lot on inventory_transactions (account_name, sku, lot_number, server_timestamp desc);
create index if not exists idx_inventory_transactions_expiry on inventory_transactions (account_name, expiration_date, server_timestamp desc);
create index if not exists idx_inventory_transactions_user on inventory_transactions (user_id, server_timestamp desc);
create index if not exists idx_inventory_transactions_source_ref on inventory_transactions (source_type, source_id, server_timestamp desc);
create index if not exists idx_inventory_transactions_type_time on inventory_transactions (transaction_type, server_timestamp desc);

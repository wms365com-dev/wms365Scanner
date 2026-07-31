alter table inventory_transactions add column if not exists idempotency_key text not null default '';

create unique index if not exists idx_inventory_transactions_idempotency
    on inventory_transactions (idempotency_key, transaction_type, source_type, location, sku)
    where idempotency_key <> '';

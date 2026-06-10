alter table portal_orders add column if not exists shipment_email_status text not null default '';
alter table portal_orders add column if not exists shipment_email_scheduled_at timestamptz;
alter table portal_orders add column if not exists shipment_email_sent_at timestamptz;
alter table portal_orders add column if not exists shipment_email_last_error text not null default '';
alter table portal_orders add column if not exists shipment_email_attempts integer not null default 0;
alter table portal_orders add column if not exists shipment_email_is_update boolean not null default false;

create index if not exists idx_portal_orders_shipment_email_due
    on portal_orders (shipment_email_status, shipment_email_scheduled_at);

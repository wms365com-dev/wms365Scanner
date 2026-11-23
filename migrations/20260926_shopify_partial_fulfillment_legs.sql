-- Additive linkage for a WMS backorder leg that shares its source Shopify order.
create table if not exists store_order_fulfillment_legs (
    portal_order_id bigint primary key references portal_orders(id) on delete restrict,
    source_portal_order_id bigint not null references portal_orders(id) on delete restrict,
    integration_id bigint not null references store_integrations(id) on delete restrict,
    external_order_id text not null,
    created_at timestamptz not null default now(),
    check (portal_order_id <> source_portal_order_id)
);

create index if not exists idx_store_order_fulfillment_legs_source
    on store_order_fulfillment_legs (source_portal_order_id, integration_id);

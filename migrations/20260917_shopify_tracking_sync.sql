-- Additive only. Shopify event acceptance is not evidence of email delivery.
-- Reviewed 2026-09-17: https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/fulfillmentEventCreate
-- https://help.shopify.com/en/manual/fulfillment/setup/notifications/customer-notifications
create table if not exists shopify_tracking_fulfillments (
    id bigserial primary key,
    integration_id bigint not null references store_integrations(id) on delete restrict,
    store_identifier text not null,
    shopify_store_gid text not null default '' check (shopify_store_gid='' or shopify_store_gid ~ '^gid://shopify/Shop/[0-9]+$'),
    shopify_store_name text not null default '',
    account_name text not null,
    order_id bigint not null references portal_orders(id) on delete restrict,
    external_order_id text not null,
    fulfillment_gid text not null check (fulfillment_gid ~ '^gid://shopify/Fulfillment/[0-9]+$'),
    expected_tracking_numbers jsonb not null check (jsonb_typeof(expected_tracking_numbers) = 'array' and jsonb_array_length(expected_tracking_numbers) > 0),
    tracking_started_at timestamptz not null default now(),
    tracking_poll_minutes integer not null default 45 check (tracking_poll_minutes between 30 and 60),
    tracking_window_days integer not null default 45 check (tracking_window_days between 1 and 180),
    enrolled_at timestamptz,
    expires_at timestamptz,
    last_shopify_check_at timestamptz,
    shipped_notifications_enqueued_at timestamptz,
    shopify_notification_state text not null default 'UNKNOWN' check (shopify_notification_state in ('UNKNOWN','REQUESTED')),
    shopify_send_state text not null default 'UNKNOWN' check (shopify_send_state = 'UNKNOWN'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (integration_id, fulfillment_gid),
    unique (id, account_name, order_id)
);
alter table shopify_tracking_fulfillments add column if not exists shopify_store_gid text not null default '' check (shopify_store_gid='' or shopify_store_gid ~ '^gid://shopify/Shop/[0-9]+$');
alter table shopify_tracking_fulfillments add column if not exists shopify_store_name text not null default '';
alter table shopify_tracking_fulfillments add column if not exists shipped_notifications_enqueued_at timestamptz;
alter table shopify_tracking_fulfillments add column if not exists shopify_notification_state text not null default 'UNKNOWN' check (shopify_notification_state in ('UNKNOWN','REQUESTED'));
alter table shopify_tracking_fulfillments add column if not exists tracking_started_at timestamptz not null default now();
alter table shopify_tracking_fulfillments add column if not exists tracking_poll_minutes integer not null default 45 check (tracking_poll_minutes between 30 and 60);
alter table shopify_tracking_fulfillments add column if not exists tracking_window_days integer not null default 45 check (tracking_window_days between 1 and 180);
alter table shopify_tracking_fulfillments add column if not exists historical_delivery_approved_at timestamptz;
create table if not exists shopify_tracking_packages (
    id bigserial primary key,
    fulfillment_binding_id bigint not null,
    account_name text not null,
    order_id bigint not null,
    fulfillment_location_id bigint not null references fulfillment_locations(id) on delete restrict,
    warehouse_shipment_id bigint not null references warehouse_shipments(id) on delete restrict,
    tracker_id bigint not null references shipment_trackers(id) on delete restrict,
    package_id text not null,
    tracking_number text not null,
    confirmed_delivered_at timestamptz,
    delivery_event_id bigint references shipment_tracking_events(id) on delete restrict,
    created_at timestamptz not null default now(),
    unique (fulfillment_binding_id, tracking_number),
    unique (fulfillment_binding_id, tracker_id),
    foreign key (fulfillment_binding_id, account_name, order_id)
        references shopify_tracking_fulfillments(id, account_name, order_id) on delete restrict
);
create table if not exists shopify_tracking_outbox (
    id bigserial primary key,
    fulfillment_binding_id bigint not null references shopify_tracking_fulfillments(id) on delete restrict,
    fulfillment_gid text not null,
    status text not null check (status in ('CARRIER_PICKED_UP','IN_TRANSIT','DELAYED','OUT_FOR_DELIVERY','ATTEMPTED_DELIVERY','DELIVERED')),
    event_at timestamptz not null,
    source_event_id bigint references shipment_tracking_events(id) on delete restrict,
    state text not null default 'PENDING' check (state in ('PENDING','RETRY','SENT','BLOCKED')),
    notification_state text not null default 'PENDING' check (notification_state in ('PENDING','REQUESTED')),
    attempts integer not null default 0 check (attempts >= 0),
    next_attempt_at timestamptz not null default now(),
    last_attempt_at timestamptz,
    last_error text not null default '',
    remote_event_gid text not null default '',
    sent_at timestamptz,
    notifications_enqueued_at timestamptz,
    discarded_at timestamptz,
    created_at timestamptz not null default now(),
    unique (fulfillment_binding_id, fulfillment_gid, status, event_at)
);
alter table shopify_tracking_outbox add column if not exists discarded_at timestamptz;
alter table shopify_tracking_outbox add column if not exists notifications_enqueued_at timestamptz;
create index if not exists idx_shopify_tracking_packages_tracker on shopify_tracking_packages(tracker_id);
create index if not exists idx_shopify_tracking_outbox_due on shopify_tracking_outbox(next_attempt_at, event_at, id) where state in ('PENDING','RETRY');
create table if not exists shopify_tracking_corrections (
    id bigserial primary key,
    fulfillment_binding_id bigint not null references shopify_tracking_fulfillments(id) on delete restrict,
    tracker_id bigint not null references shipment_trackers(id) on delete restrict,
    actor text not null,
    reason text not null,
    action text not null check (action in ('INVALIDATE_DELIVERY','REPLAY_EVENTS','MANUAL_CLOSE','REOPEN_TRACKING')),
    created_at timestamptz not null default now()
);
alter table shipment_trackers add column if not exists manual_closed_at timestamptz;
create table if not exists shopify_tracking_order_contacts (
    integration_id bigint not null references store_integrations(id) on delete restrict,
    order_id bigint not null references portal_orders(id) on delete restrict,
    account_name text not null,
    external_order_id text not null,
    recipient_email text not null default '',
    shopify_order_number text not null default '',
    updated_at timestamptz not null default now(),
    primary key (integration_id, order_id)
);
alter table shopify_tracking_order_contacts add column if not exists shopify_order_number text not null default '';

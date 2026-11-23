-- Additive and opt-in only. Applying this migration never enables delivery.
begin;

create table if not exists shopify_delivery_notification_settings (
    integration_id bigint primary key references store_integrations(id),
    enabled boolean not null default false,
    delivery_mode text not null default 'SHOPIFY' check (delivery_mode in ('SHOPIFY', 'WMS365', 'BOTH')),
    enabled_events jsonb not null default '["SHIPPED","EXCEPTION","OUT_FOR_DELIVERY","DELIVERY_ATTEMPTED","DELIVERED"]'::jsonb,
    sms_enabled boolean not null default false,
    brand_name text not null default '',
    logo_url text not null default '',
    message_template text not null default '',
    updated_at timestamptz not null default now(),
    check (jsonb_typeof(enabled_events) = 'array'),
    check (enabled_events <@ '["SHIPPED","EXCEPTION","OUT_FOR_DELIVERY","DELIVERY_ATTEMPTED","DELIVERED","IN_TRANSIT","PICKED_UP"]'::jsonb)
);

create table if not exists shopify_delivery_notification_native_reviews (
    integration_id bigint not null references store_integrations(id),
    account_name text not null,
    event_type text not null check (event_type in ('SHIPPED','OUT_FOR_DELIVERY','DELIVERED')),
    configuration_state text not null default 'UNKNOWN' check (configuration_state in ('ENABLED','DISABLED','UNKNOWN')),
    reviewed_at timestamptz not null,
    reviewed_by text not null check (length(reviewed_by) > 0),
    evidence_ref text not null check (length(evidence_ref) > 0),
    primary key (integration_id, account_name, event_type)
);

create table if not exists shopify_delivery_notification_review_audit (
    id bigserial primary key,
    integration_id bigint not null references store_integrations(id),
    account_name text not null,
    event_type text not null check (event_type in ('SHIPPED','OUT_FOR_DELIVERY','DELIVERED')),
    configuration_state text not null check (configuration_state in ('ENABLED','DISABLED','UNKNOWN')),
    reviewed_at timestamptz not null default now(),
    reviewed_by text not null,
    evidence_ref text not null
);

-- The outbox is also the durable delivery log. Do not delete uncertain/sent rows
-- during retries; dedup keys and provider idempotency keys must remain stable.
create table if not exists shopify_delivery_notification_outbox (
    id bigserial primary key,
    integration_id bigint not null references store_integrations(id),
    account_name text not null,
    warehouse_id text not null,
    order_id text not null,
    shipment_id text not null,
    event_type text not null,
    delivery_mode text not null check (delivery_mode in ('SHOPIFY', 'WMS365', 'BOTH')),
    channel text not null check (channel in ('EMAIL', 'SMS')),
    recipient text not null,
    recipient_consent boolean not null default false,
    provenance jsonb not null default '{}'::jsonb,
    payload jsonb not null,
    shopify_send_state text not null default 'UNKNOWN' check (shopify_send_state in ('UNKNOWN', 'REQUESTED', 'SENT', 'NOT_SENT')),
    dedup_key text not null,
    status text not null default 'PENDING' check (status in ('PENDING','DEFERRED','SENDING','SENT','UNCERTAIN','SUPPRESSED','FAILED')),
    provider_id text not null default '',
    provider_message_id text not null default '',
    claim_token text,
    lease_expires_at timestamptz,
    attempts integer not null default 0 check (attempts >= 0),
    outcome_code text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    sent_at timestamptz,
    unique (integration_id, account_name, dedup_key),
    check ((status = 'SENT') = (sent_at is not null)),
    check (channel <> 'SMS' or recipient_consent)
);

create index if not exists shopify_delivery_outbox_pending
    on shopify_delivery_notification_outbox (created_at, id)
    where status in ('PENDING', 'UNCERTAIN');
create index if not exists shopify_delivery_outbox_lease
    on shopify_delivery_notification_outbox (lease_expires_at)
    where status = 'SENDING';
create index if not exists shopify_delivery_outbox_scope
    on shopify_delivery_notification_outbox (account_name, integration_id, warehouse_id, order_id);

commit;

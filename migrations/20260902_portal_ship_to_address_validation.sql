begin;

alter table portal_orders
    add column if not exists ship_to_address_status text not null default 'SAVED',
    add column if not exists ship_to_address_provider text not null default '',
    add column if not exists ship_to_address_place_id text not null default '',
    add column if not exists ship_to_address_response_id text not null default '',
    add column if not exists ship_to_address_formatted text not null default '',
    add column if not exists ship_to_address_fingerprint text not null default '',
    add column if not exists ship_to_address_verified_at timestamptz,
    add column if not exists ship_to_address_override_reason text not null default '',
    add column if not exists ship_to_address_override_note text not null default '',
    add column if not exists ship_to_address_overridden_at timestamptz,
    add column if not exists ship_to_address_overridden_by bigint references portal_vendor_access(id) on delete set null;

alter table portal_orders
    drop constraint if exists portal_orders_ship_to_address_status_check;

alter table portal_orders
    add constraint portal_orders_ship_to_address_status_check
    check (ship_to_address_status in ('SAVED', 'VERIFIED', 'OVERRIDDEN', 'PENDING', 'INTERNAL'));

alter table portal_ship_to_addresses
    add column if not exists verification_status text not null default 'SAVED',
    add column if not exists verification_provider text not null default '',
    add column if not exists verification_place_id text not null default '',
    add column if not exists verified_at timestamptz;

commit;

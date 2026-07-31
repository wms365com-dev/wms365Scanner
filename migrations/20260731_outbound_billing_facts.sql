-- Structured outbound facts used to create reviewable billing events.

alter table portal_orders add column if not exists outbound_freight_cost numeric(12,2) not null default 0;
alter table portal_orders add column if not exists outbound_labour_hours numeric(12,2) not null default 0;
alter table portal_orders add column if not exists outbound_special_labour_note text not null default '';

insert into billing_fee_catalog (code, category, name, unit_label, default_rate, is_active)
values
    ('RUSH_ORDER_FEE', 'Administrative Fees', 'Rush order fee', 'per order', 0, true),
    ('FREIGHT_CHARGE', 'Shipping & Handling', 'Freight charge', 'per dollar', 0, true),
    ('SPECIAL_LABOUR', 'Labour & Equipment', 'Special labour', 'per hour', 0, true)
on conflict (code) do update set
    category = excluded.category,
    name = excluded.name,
    unit_label = excluded.unit_label,
    is_active = true,
    updated_at = now();

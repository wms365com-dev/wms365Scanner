alter table portal_orders
    add column if not exists picking_at timestamptz;

alter table portal_orders
    drop constraint if exists portal_orders_status_check;

alter table portal_orders
    add constraint portal_orders_status_check
    check (status in ('DRAFT', 'RELEASED', 'PICKING', 'PICKED', 'STAGED', 'SHIPPED', 'CANCELLED', 'ARCHIVED'));

alter table warehouse_shipments
    drop constraint if exists warehouse_shipments_status_check;

alter table warehouse_shipments
    add constraint warehouse_shipments_status_check
    check (status in ('RELEASED', 'PICKING', 'PICKED', 'STAGED', 'SHIPPED', 'CANCELLED'));

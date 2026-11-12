begin;

alter table warehouse_shipments
    add column if not exists total_weight numeric(12,3),
    add column if not exists weight_uom text not null default 'LB',
    add column if not exists delivery_date date;

alter table warehouse_shipments
    drop constraint if exists warehouse_shipments_weight_uom_check;

alter table warehouse_shipments
    add constraint warehouse_shipments_weight_uom_check
    check (weight_uom in ('LB', 'KG'));

alter table warehouse_shipments
    drop constraint if exists warehouse_shipments_total_weight_check;

alter table warehouse_shipments
    add constraint warehouse_shipments_total_weight_check
    check (total_weight is null or total_weight > 0);

commit;

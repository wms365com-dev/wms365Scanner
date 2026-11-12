alter table item_catalog
    add column if not exists unit_uom text not null default '';

alter table company_fulfillment_locations
    add column if not exists customer_portal_visible boolean not null default true;

alter table company_fulfillment_locations
    add column if not exists portal_inventory_rollup_location_id bigint
        references fulfillment_locations(id) on delete set null;

alter table company_fulfillment_locations
    drop constraint if exists company_fulfillment_locations_portal_rollup_not_self;

alter table company_fulfillment_locations
    add constraint company_fulfillment_locations_portal_rollup_not_self
    check (
        portal_inventory_rollup_location_id is null
        or portal_inventory_rollup_location_id <> fulfillment_location_id
    );

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'company_fulfillment_locations_portal_rollup_account_fkey'
    ) then
        alter table company_fulfillment_locations
            add constraint company_fulfillment_locations_portal_rollup_account_fkey
            foreign key (account_name, portal_inventory_rollup_location_id)
            references company_fulfillment_locations (account_name, fulfillment_location_id)
            on delete restrict;
    end if;
end $$;

create index if not exists idx_company_fulfillment_locations_portal_rollup
    on company_fulfillment_locations (account_name, portal_inventory_rollup_location_id)
    where portal_inventory_rollup_location_id is not null;

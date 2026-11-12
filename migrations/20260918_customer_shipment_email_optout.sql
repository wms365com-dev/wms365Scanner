-- Company-wide opt-out uses the existing tenant-scoped preference table.
-- It affects only the WMS shipment-confirmation queue, not store integrations.
create or replace function public.wms365_shipment_email_subscribed(p_account text)
returns boolean language sql stable set search_path = public, pg_catalog as $$
    select not exists (
        select 1 from public.customer_email_preferences
        where account_name = p_account and email = '*'
          and notification_type = 'SHIPMENT_CONFIRMATION' and is_subscribed = false
    );
$$;

create or replace function public.wms365_guard_shipment_email_queue()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
    if new.shipment_email_status in ('SCHEDULED', 'SENDING')
       and not public.wms365_shipment_email_subscribed(new.account_name) then
        -- A scheduler must not receive a successful claim for an opted-out order.
        if tg_op = 'UPDATE' and new.shipment_email_status = 'SENDING' then
            return null;
        end if;
        new.shipment_email_status := 'SKIPPED';
        new.shipment_email_scheduled_at := null;
        new.shipment_email_last_error := 'Company opted out of individual shipment confirmations.';
    end if;
    return new;
end;
$$;

drop trigger if exists wms365_shipment_email_preference_guard on public.portal_orders;
create trigger wms365_shipment_email_preference_guard
before insert or update of shipment_email_status on public.portal_orders
for each row execute function public.wms365_guard_shipment_email_queue();

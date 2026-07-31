-- WMS365 operational controls: count governance and immutable task history.

alter table inventory_count_records add column if not exists approval_required boolean not null default true;
alter table inventory_count_records add column if not exists variance_percent numeric(12,4) not null default 0;
alter table inventory_count_records add column if not exists variance_severity text not null default 'NONE';
alter table inventory_count_records add column if not exists recount_of_id bigint references inventory_count_records(id) on delete set null;
alter table inventory_count_records add column if not exists attempt_number integer not null default 1;
alter table inventory_count_records add column if not exists evidence jsonb not null default '{}'::jsonb;
create index if not exists idx_inventory_count_records_recount
    on inventory_count_records (recount_of_id, attempt_number);

create table if not exists warehouse_task_history (
    id bigserial primary key,
    task_id bigint not null references warehouse_tasks(id) on delete cascade,
    action text not null,
    old_status text not null default '',
    new_status text not null default '',
    assigned_app_user_id bigint,
    actor text not null default '',
    blocked_reason text not null default '',
    snapshot jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create or replace function record_warehouse_task_history()
returns trigger as $$
begin
    insert into warehouse_task_history (
        task_id, action, old_status, new_status, assigned_app_user_id,
        actor, blocked_reason, snapshot
    )
    values (
        new.id,
        case when tg_op = 'INSERT' then 'CREATED'
             when old.status is distinct from new.status then 'STATUS_CHANGED'
             when old.assigned_app_user_id is distinct from new.assigned_app_user_id then 'ASSIGNED'
             else 'UPDATED' end,
        case when tg_op = 'INSERT' then '' else old.status end,
        new.status,
        new.assigned_app_user_id,
        coalesce(new.completed_by, ''),
        coalesce(new.blocked_reason, ''),
        to_jsonb(new)
    );
    return new;
end;
$$ language plpgsql;

drop trigger if exists warehouse_task_history_trigger on warehouse_tasks;
create trigger warehouse_task_history_trigger
after insert or update on warehouse_tasks
for each row execute function record_warehouse_task_history();

create index if not exists idx_warehouse_task_history_task_time
    on warehouse_task_history (task_id, created_at desc);

create or replace function prevent_warehouse_task_history_change()
returns trigger as $$
begin
    raise exception 'Warehouse task history is append-only';
end;
$$ language plpgsql;

drop trigger if exists warehouse_task_history_immutable on warehouse_task_history;
create trigger warehouse_task_history_immutable
before update or delete on warehouse_task_history
for each row execute function prevent_warehouse_task_history_change();

create table if not exists billing_event_audit (
    id bigserial primary key,
    billing_event_id bigint not null references billing_events(id) on delete restrict,
    action text not null,
    old_status text not null default '',
    new_status text not null default '',
    snapshot jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create or replace function protect_and_audit_billing_event()
returns trigger as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Billing events must be voided or credited, not deleted';
    end if;
    if tg_op = 'UPDATE'
       and lower(trim(old.status)) in ('approved', 'invoiced')
       and (to_jsonb(old) - array['status','invoice_id','invoice_number','invoiced_at','updated_at'])
           is distinct from
           (to_jsonb(new) - array['status','invoice_id','invoice_number','invoiced_at','updated_at']) then
        raise exception 'Approved billing source facts are locked; create a void or credit event';
    end if;
    insert into billing_event_audit (
        billing_event_id, action, old_status, new_status, snapshot
    )
    values (
        new.id,
        case when tg_op = 'INSERT' then 'CREATED'
             when old.status is distinct from new.status then 'STATUS_CHANGED'
             else 'UPDATED' end,
        case when tg_op = 'INSERT' then '' else old.status end,
        new.status,
        to_jsonb(new)
    );
    return new;
end;
$$ language plpgsql;

drop trigger if exists billing_event_control_trigger on billing_events;
create trigger billing_event_control_trigger
after insert or update or delete on billing_events
for each row execute function protect_and_audit_billing_event();

create index if not exists idx_billing_event_audit_event_time
    on billing_event_audit (billing_event_id, created_at desc);

create or replace function prevent_billing_event_audit_change()
returns trigger as $$
begin
    raise exception 'Billing event audit is append-only';
end;
$$ language plpgsql;

drop trigger if exists billing_event_audit_immutable on billing_event_audit;
create trigger billing_event_audit_immutable
before update or delete on billing_event_audit
for each row execute function prevent_billing_event_audit_change();

alter table store_integrations
    add column if not exists sync_claimed_at timestamptz;

alter table store_integrations
    add column if not exists sync_claim_token text not null default '';

alter table store_integrations
    drop constraint if exists store_integrations_sync_status_check;

alter table store_integrations
    add constraint store_integrations_sync_status_check
    check (last_sync_status in ('IDLE', 'RUNNING', 'SUCCESS', 'WARNING', 'ERROR'));

create index if not exists idx_store_integrations_sync_claim
    on store_integrations (sync_claimed_at)
    where sync_claimed_at is not null;

create table if not exists import_backups (
    id bigserial primary key,
    backup_type text not null default 'FULL_IMPORT',
    created_by text not null default '',
    source_ip text not null default '',
    backup_payload jsonb not null,
    created_at timestamptz not null default now()
);

create index if not exists idx_import_backups_created_at on import_backups (created_at desc);

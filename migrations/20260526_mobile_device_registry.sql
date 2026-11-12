create table if not exists mobile_devices (
    id bigserial primary key,
    device_id text not null,
    app_source text not null default 'android_app',
    app_name text not null default '',
    package_name text not null default '',
    platform text not null default 'android',
    manufacturer text not null default '',
    model text not null default '',
    os_version text not null default '',
    sdk_version text not null default '',
    app_version text not null default '',
    app_version_code text not null default '',
    scanner_type text not null default '',
    last_user_id bigint,
    last_user_email text not null default '',
    last_account_name text not null default '',
    status text not null default 'ACTIVE',
    notes text not null default '',
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    last_login_at timestamptz,
    last_checkin_at timestamptz,
    last_ip text not null default '',
    user_agent text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (device_id, app_source)
);

create index if not exists idx_mobile_devices_last_seen on mobile_devices (last_seen_at desc);
create index if not exists idx_mobile_devices_user on mobile_devices (last_user_email);
create index if not exists idx_mobile_devices_account on mobile_devices (last_account_name);
create index if not exists idx_mobile_devices_status on mobile_devices (status);

create table if not exists site_traffic_events (
    id bigserial primary key,
    event_hash text not null unique,
    visitor_hash text not null,
    session_hash text not null,
    page_path text not null,
    referrer_host text not null default '',
    device_type text not null default 'DESKTOP',
    occurred_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint site_traffic_device_type_check
        check (device_type in ('DESKTOP', 'MOBILE', 'TABLET', 'OTHER'))
);

create index if not exists idx_site_traffic_events_occurred_at
    on site_traffic_events (occurred_at desc);

create index if not exists idx_site_traffic_events_page_time
    on site_traffic_events (page_path, occurred_at desc);

create index if not exists idx_site_traffic_events_visitor_time
    on site_traffic_events (visitor_hash, occurred_at desc);

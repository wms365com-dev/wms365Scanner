alter table portal_vendor_access add column if not exists portal_permissions jsonb;

create index if not exists idx_portal_vendor_access_account_name on portal_vendor_access (account_name);

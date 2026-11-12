# WMS365 RBAC Permission Matrix

## Roles

- `SUPER_ADMIN`: platform owner; full access across all companies.
- `WAREHOUSE_ADMIN`: warehouse operations manager; can adjust inventory, review/post counts, manage operational integrations, and update warehouse document statuses for assigned companies.
- `WAREHOUSE_CUSTOMER_SERVICE`: customer service operations; can execute mobile-safe/customer-service order and inbound status actions for assigned companies, but cannot adjust inventory or manage integrations.
- `WAREHOUSE_WORKER`: floor user; can submit mobile work for assigned companies and complete assigned mobile order/inbound tasks only.
- `CUSTOMER_PORTAL_USER`: customer portal user; can access only its own account/company portal data.

## Permission Map

| Permission | Super Admin | Warehouse Admin | Customer Service | Warehouse Worker | Customer Portal |
| --- | --- | --- | --- | --- | --- |
| `super_admin` | Yes | No | No | No | No |
| `warehouse_admin` | Yes | Yes | No | No | No |
| `inventory_count_submit` | Yes | Yes | Yes | Yes | No |
| `inventory_count_review` | Yes | Yes | No | No | No |
| `inventory_adjust` | Yes | Yes | No | No | No |
| `mobile_worker_action` | Yes | Yes | Yes | Yes | No |
| `order_status_update` | Yes | Yes | Yes | Assigned task only | No |
| `inbound_status_update` | Yes | Yes | Yes | Assigned task only | No |
| `integration_manage` | Yes | Yes | No | No | No |
| `destructive_import` | Yes | No | No | No | No |
| `customer_portal_own_account` | Yes | No | No | No | Own account only |

## Hardened Routes

- `POST /api/inventory-counts`: mobile worker action.
- `POST /api/inventory-counts/:id`: warehouse admin.
- `POST /api/inventory-counts/:id/reject`: warehouse admin.
- `POST /api/inventory-counts/:id/approve`: warehouse admin.
- `POST /api/inventory-counts/:id/post`: inventory adjustment permission.
- `POST /api/batch-save`: mobile worker action.
- `POST /api/remove-quantity`: inventory adjustment permission.
- `POST /api/delete-line`: inventory adjustment permission.
- `POST /api/transfer`: inventory adjustment permission.
- `POST /api/put-away`: inventory adjustment permission.
- `POST /api/move-location`: inventory adjustment permission.
- `POST /api/inventory/bulk-update`: inventory adjustment permission.
- `POST /api/admin/portal-orders/:id/status`: mobile worker action; warehouse workers must have an assigned active source task.
- `POST /api/admin/portal-inbounds/:id/status`: mobile worker action; warehouse workers must have an assigned active source task.
- `POST /api/admin/integrations`: warehouse admin.
- `POST /api/admin/integrations/:id/sync`: warehouse admin.
- `POST /api/import`: super admin.

## Audit

Permission-denied attempts are logged to `activity_log` with type `security` when the database is ready. The audit entry includes user, role, method, URL, company when available, and IP address.

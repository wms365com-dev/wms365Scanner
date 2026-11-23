alter table store_integrations drop constraint if exists store_integrations_sync_schedule_check;

alter table store_integrations add constraint store_integrations_sync_schedule_check check (sync_schedule in (
    'MANUAL', 'EVERY_5_MINUTES', 'EVERY_15_MINUTES', 'EVERY_30_MINUTES', 'HOURLY',
    'WEEKDAYS_5X_0600_1600', 'DAILY_3X_0730_1430',
    'DAILY_0900', 'DAILY_1200', 'DAILY_1500', 'DAILY_1800'
));

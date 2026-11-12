"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const sql=fs.readFileSync('migrations/20260918_customer_shipment_email_optout.sql','utf8');

test('shipment email opt-out is tenant-scoped, explicit and default-on',()=>{
    assert.match(sql,/account_name = p_account and email = '\*'/);
    assert.match(sql,/notification_type = 'SHIPMENT_CONFIRMATION' and is_subscribed = false/);
    assert.match(sql,/select not exists/);
    assert.doesNotMatch(sql,/RANCHER|update store_integrations|update inventory|security definer/i);
});
test('shipment opt-out suppresses new queue schedules and refuses successful scheduler claims',()=>{
    assert.match(sql,/update of shipment_email_status on public\.portal_orders/);
    assert.match(sql,/new\.shipment_email_status := 'SKIPPED'/);
    assert.match(sql,/new\.shipment_email_scheduled_at := null/);
    assert.match(sql,/new\.shipment_email_status = 'SENDING' then\s+return null/);
});

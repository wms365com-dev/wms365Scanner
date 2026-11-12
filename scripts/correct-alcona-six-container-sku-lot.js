const { Client } = require('pg');

const ACCOUNT = 'ALCONA TRADING LTD';
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = 'WHS01';
const OLD_SKU = 'MS26060402G';
const NEW_SKU = 'MS26062403';
const INBOUNDS = new Map([
    [144, 'HPXU104658'],
    [145, 'HPXU104646'],
    [146, 'HPXU104846'],
    [147, 'HPXU104656'],
    [148, 'HPXU104693'],
    [149, 'HPXU104781']
]);
const IDS = [...INBOUNDS.keys()];
const EXPECTED_COUNTS = Object.freeze({
    item_catalog: 1,
    portal_inbound_lines: 6,
    portal_inbound_pallet_labels: 120,
    portal_inbound_pallet_label_contents: 120,
    inventory_lines: 45,
    inventory_transactions: 215,
    portal_order_lines: 7,
    portal_order_allocations: 28,
    portal_order_shipment_lines: 3,
    warehouse_shipment_lines: 7
});
const SKU_TABLES = Object.keys(EXPECTED_COUNTS);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function rows(client, sql, params = []) {
    return (await client.query(sql, params)).rows;
}

async function count(client, sql, params = []) {
    return Number((await rows(client, sql, params))[0].n);
}

async function snapshot(client) {
    const specs = {
        item_catalog: 'select id,sku,description,lot_tracked,updated_at from item_catalog where account_name=$1 and sku=$2',
        portal_inbounds: 'select id,reference_number,notes from portal_inbounds where account_name=$1 and id=any($2::bigint[]) order by id',
        portal_inbound_lines: 'select id,inbound_id,sku,lot_number,updated_at from portal_inbound_lines where inbound_id=any($1::bigint[]) order by id',
        portal_inbound_receipt_allocations: 'select id,inbound_id,lot_number,updated_at from portal_inbound_receipt_allocations where inbound_id=any($1::bigint[]) order by id',
        portal_inbound_pallet_labels: 'select id,inbound_id,sku,description,updated_at from portal_inbound_pallet_labels where inbound_id=any($1::bigint[]) order by id',
        portal_inbound_pallet_label_contents: 'select id,inbound_id,sku,lot_number,updated_at from portal_inbound_pallet_label_contents where inbound_id=any($1::bigint[]) order by id',
        inventory_lines: 'select id,location,sku,lot_number,quantity,updated_at from inventory_lines where account_name=$1 and sku=$2 order by id',
        inventory_transactions: 'select id,location,sku,lot_number,quantity_delta,source_type,source_id from inventory_transactions where account_name=$1 and sku=$2 order by id',
        portal_order_lines: 'select l.id,l.order_id,l.sku,l.updated_at from portal_order_lines l join portal_orders o on o.id=l.order_id where o.account_name=$1 and l.sku=$2 order by l.id',
        portal_order_allocations: 'select a.id,a.order_id,a.inventory_line_id,a.sku,a.lot_number,a.updated_at from portal_order_allocations a join portal_orders o on o.id=a.order_id where o.account_name=$1 and a.sku=$2 order by a.id',
        portal_order_shipment_lines: 'select s.id,s.order_id,s.sku,s.updated_at from portal_order_shipment_lines s join portal_orders o on o.id=s.order_id where o.account_name=$1 and s.sku=$2 order by s.id',
        warehouse_shipment_lines: 'select l.id,s.order_id,l.sku,l.updated_at from warehouse_shipment_lines l join warehouse_shipments s on s.id=l.shipment_id where s.account_name=$1 and l.sku=$2 order by l.id'
    };
    const result = {};
    for (const [table, sql] of Object.entries(specs)) {
        const params = table === 'portal_inbounds' ? [ACCOUNT, IDS]
            : table === 'portal_inbound_lines' ||
              table === 'portal_inbound_receipt_allocations' ||
              table === 'portal_inbound_pallet_labels' ||
              table === 'portal_inbound_pallet_label_contents' ? [IDS]
            : [ACCOUNT, OLD_SKU];
        result[table] = await rows(client, sql, params);
    }
    return result;
}

async function preflight(client) {
    const warehouse = await rows(client, 'select id,code from fulfillment_locations where id=$1', [WAREHOUSE_ID]);
    assert(warehouse.length === 1 && warehouse[0].code === WAREHOUSE_CODE, 'Pinned warehouse identity changed.');

    const inbounds = await rows(client,
        'select id,reference_number,status,fulfillment_location_id,notes from portal_inbounds where id=any($1::bigint[]) and account_name=$2 order by id',
        [IDS, ACCOUNT]);
    assert(inbounds.length === IDS.length, 'Six exact Alcona inbounds were not found.');
    for (const inbound of inbounds) {
        assert(INBOUNDS.get(Number(inbound.id)) === inbound.reference_number &&
            Number(inbound.fulfillment_location_id) === WAREHOUSE_ID &&
            inbound.status === 'PUTAWAY_COMPLETE' &&
            inbound.notes.includes(OLD_SKU), `Inbound ${inbound.id} changed or is out of scope.`);
    }

    const inboundLines = await rows(client,
        'select inbound_id,sku,lot_number,expected_quantity,received_quantity from portal_inbound_lines where inbound_id=any($1::bigint[]) order by inbound_id',
        [IDS]);
    assert(inboundLines.length === 6 && inboundLines.every(line => line.sku === OLD_SKU &&
        line.lot_number === '' && Number(line.expected_quantity) === 20 &&
        Number(line.received_quantity) === 20), 'The six receipt lines no longer match 20 pallets each.');

    const catalog = await rows(client,
        'select id,sku,tracking_level,lot_tracked,description from item_catalog where account_name=$1 and sku in ($2,$3)',
        [ACCOUNT, OLD_SKU, NEW_SKU]);
    assert(catalog.length === 1 && catalog[0].sku === OLD_SKU &&
        catalog[0].tracking_level === 'PALLET' && catalog[0].lot_tracked === false,
    'Alcona item master changed or target SKU already exists.');

    // A new reference in any SKU-bearing table is a stop signal, not a guessed migration rule.
    const allSkuTables = await rows(client,
        "select table_name from information_schema.columns where table_schema='public' and column_name='sku' order by table_name");
    for (const { table_name: table } of allSkuTables) {
        assert(/^[a-z_]+$/.test(table), 'Unexpected SQL table name.');
        const oldCount = await count(client, `select count(*)::int n from ${table} where sku=$1`, [OLD_SKU]);
        const targetCount = await count(client, `select count(*)::int n from ${table} where sku=$1`, [NEW_SKU]);
        assert(targetCount === 0, `${table} already contains ${NEW_SKU}.`);
        assert(oldCount === (EXPECTED_COUNTS[table] || 0),
            `${table} has ${oldCount} old-SKU rows, expected ${EXPECTED_COUNTS[table] || 0}.`);
    }

    const receiptAllocations = await rows(client,
        'select id,lot_number from portal_inbound_receipt_allocations where inbound_id=any($1::bigint[])', [IDS]);
    assert(receiptAllocations.length === 9 && receiptAllocations.every(row => row.lot_number === ''),
        'Receipt allocations changed.');
    const labelContents = await rows(client,
        'select id,sku,lot_number from portal_inbound_pallet_label_contents where inbound_id=any($1::bigint[])', [IDS]);
    assert(labelContents.length === 120 && labelContents.every(row => row.sku === OLD_SKU && row.lot_number === ''),
        'Pallet label contents changed.');
    const labels = await rows(client,
        'select id,sku,description from portal_inbound_pallet_labels where inbound_id=any($1::bigint[])', [IDS]);
    assert(labels.length === 120 && labels.every(row => row.sku === OLD_SKU && row.description === OLD_SKU),
        'Pallet label descriptions changed.');

    const stock = await rows(client,
        `select count(*)::int lines,coalesce(sum(i.quantity),0)::int on_hand,
                count(*) filter (where i.lot_number<>'' or i.tracking_level<>'PALLET'
                    or b.fulfillment_location_id<>$3 or b.id is null)::int invalid
         from inventory_lines i left join bin_locations b on b.code=i.location and b.account_name=i.account_name
         where i.account_name=$1 and i.sku=$2`, [ACCOUNT, OLD_SKU, WAREHOUSE_ID]);
    assert(stock[0].lines === 45 && stock[0].on_hand === 108 && stock[0].invalid === 0,
        'On-hand stock, lot, tracking, or warehouse changed.');
    const ledger = await rows(client,
        `select count(*)::int events,coalesce(sum(quantity_delta),0)::int net,
                count(*) filter (where lot_number<>'' or warehouse_id not in ('',$3)
                    or (fulfillment_location_id is not null and fulfillment_location_id<>$4))::int invalid
         from inventory_transactions where account_name=$1 and sku=$2`,
        [ACCOUNT, OLD_SKU, WAREHOUSE_CODE, WAREHOUSE_ID]);
    assert(ledger[0].events === 215 && ledger[0].net === 108 && ledger[0].invalid === 0,
        'Inventory ledger changed or is inconsistent with on-hand stock.');

    const orders = await rows(client,
        `select o.id,o.order_code,o.status,o.fulfillment_location_id,l.id line_id,l.sku,l.requested_quantity
         from portal_order_lines l join portal_orders o on o.id=l.order_id
         where o.account_name=$1 and l.sku=$2 order by o.id`, [ACCOUNT, OLD_SKU]);
    const expectedOrders = new Map([
        ['ORD-001204', 'SHIPPED'], ['ORD-001338', 'SHIPPED'], ['ORD-001339', 'SHIPPED'],
        ['ORD-001340', 'STAGED'], ['ORD-001341', 'RELEASED'],
        ['ORD-001395', 'RELEASED'], ['ORD-001396', 'RELEASED']
    ]);
    assert(orders.length === 7 && orders.every(order =>
        expectedOrders.get(order.order_code) === order.status &&
        Number(order.fulfillment_location_id) === WAREHOUSE_ID &&
        Number(order.requested_quantity) === 4), 'Affected orders changed.');
    const allocations = await rows(client,
        `select a.id,a.sku,a.lot_number,a.inventory_line_id,i.sku inventory_sku
         from portal_order_allocations a join portal_orders o on o.id=a.order_id
         left join inventory_lines i on i.id=a.inventory_line_id
         where o.account_name=$1 and a.sku=$2`, [ACCOUNT, OLD_SKU]);
    assert(allocations.length === 28 && allocations.every(a => a.lot_number === '' &&
        (a.inventory_sku === null || a.inventory_sku === OLD_SKU)), 'Order allocations changed.');

    return { inbounds: [...INBOUNDS.values()], received: 120, shipped: 12,
        onHand: 108, openAllocated: 16, orders: orders.map(o => ({ number: o.order_code, status: o.status })),
        rowCounts: EXPECTED_COUNTS };
}

async function update(client, name, sql, params, expected) {
    const result = await client.query(sql, params);
    assert(result.rowCount === expected, `${name}: updated ${result.rowCount}, expected ${expected}.`);
}

async function apply(client, before, backupPayload) {
    const backup = await rows(client,
        `insert into import_backups (backup_type,created_by,source_ip,backup_payload)
         values ('ALCONA_SKU_LOT_CORRECTION','Codex owner-approved live correction','local-agent',$1::jsonb)
         returning id`, [JSON.stringify({ scope: { account: ACCOUNT, warehouseId: WAREHOUSE_ID,
            oldSku: OLD_SKU, newSku: NEW_SKU, inboundIds: IDS, orderNumbers: before.orders.map(o => o.number) },
            originalValues: backupPayload })]);
    const backupId = backup[0].id;
    const base = [ACCOUNT, OLD_SKU, NEW_SKU];

    await update(client, 'item_catalog',
        `update item_catalog set sku=$3,description=$3,lot_tracked=true,updated_at=now()
         where account_name=$1 and sku=$2`, base, 1);
    await update(client, 'portal_inbounds',
        `update portal_inbounds set notes=replace(notes,$2,$3),updated_at=now()
         where account_name=$1 and id=any($4::bigint[]) and notes like '%'||$2||'%'`,
        [...base, IDS], 6);
    await update(client, 'portal_inbound_lines',
        `update portal_inbound_lines set sku=$3,lot_number=$3,updated_at=now()
         where inbound_id=any($1::bigint[]) and sku=$2 and lot_number=''`, [IDS, OLD_SKU, NEW_SKU], 6);
    await update(client, 'portal_inbound_receipt_allocations',
        `update portal_inbound_receipt_allocations set lot_number=$2,updated_at=now()
         where inbound_id=any($1::bigint[]) and lot_number=''`, [IDS, NEW_SKU], 9);
    await update(client, 'portal_inbound_pallet_labels',
        `update portal_inbound_pallet_labels set sku=$3,description=$3,updated_at=now()
         where account_name=$1 and inbound_id=any($4::bigint[]) and sku=$2 and description=$2`, [...base, IDS], 120);
    await update(client, 'portal_inbound_pallet_label_contents',
        `update portal_inbound_pallet_label_contents set sku=$3,lot_number=$3,updated_at=now()
         where inbound_id=any($1::bigint[]) and sku=$2 and lot_number=''`, [IDS, OLD_SKU, NEW_SKU], 120);
    await update(client, 'inventory_lines',
        `update inventory_lines set sku=$3,lot_number=$3,updated_at=now()
         where account_name=$1 and sku=$2 and lot_number=''`, base, 45);
    await update(client, 'portal_order_lines',
        `update portal_order_lines l set sku=$3,updated_at=now()
         from portal_orders o where o.id=l.order_id and o.account_name=$1 and l.sku=$2`, base, 7);
    await update(client, 'portal_order_allocations',
        `update portal_order_allocations a set sku=$3,lot_number=$3,updated_at=now()
         from portal_orders o where o.id=a.order_id and o.account_name=$1 and a.sku=$2 and a.lot_number=''`, base, 28);
    await update(client, 'portal_order_shipment_lines',
        `update portal_order_shipment_lines s set sku=$3,updated_at=now()
         from portal_orders o where o.id=s.order_id and o.account_name=$1 and s.sku=$2`, base, 3);
    await update(client, 'warehouse_shipment_lines',
        `update warehouse_shipment_lines l set sku=$3,updated_at=now()
         from warehouse_shipments s where s.id=l.shipment_id and s.account_name=$1 and l.sku=$2`, base, 7);

    // The inventory ledger is append-only. Bridge its original SKU balance to the corrected SKU.
    const bridge = await client.query(
        `insert into inventory_transactions (
            account_name,warehouse_id,fulfillment_location_id,location,sku,upc,lot_number,
            expiration_date,transaction_type,quantity_delta,quantity_before,quantity_after,
            source_type,source_id,idempotency_key,source,pallet_code)
         select i.account_name,$4::text,$5::bigint,i.location,$7::text,i.upc,'',i.expiration_date,
                'SKU_RECLASSIFY',-i.quantity,i.quantity,0,'ITEM_MASTER_CORRECTION',$6::text,
                'alcona-six-container-sku-lot-old-'||i.id,'owner-approved-sku-lot-correction',''
         from inventory_lines i where i.account_name=$1 and i.sku=$2 and i.lot_number=$3
         union all
         select i.account_name,$4::text,$5::bigint,i.location,$2::text,i.upc,$3::text,i.expiration_date,
                'SKU_RECLASSIFY',i.quantity,0,i.quantity,'ITEM_MASTER_CORRECTION',$6::text,
                'alcona-six-container-sku-lot-new-'||i.id,'owner-approved-sku-lot-correction',''
         from inventory_lines i where i.account_name=$1 and i.sku=$2 and i.lot_number=$3`,
        [ACCOUNT, NEW_SKU, NEW_SKU, WAREHOUSE_CODE, WAREHOUSE_ID, String(backupId), OLD_SKU]);
    assert(bridge.rowCount === 90, 'Inventory reclassification did not match 45 stock rows per SKU.');
    await client.query(
        `insert into activity_log (type,title,details) values ('item',$1,$2)`,
        [`Corrected Alcona SKU and lot to ${NEW_SKU}`,
            `Six HPXU containers; ${OLD_SKU} -> ${NEW_SKU}; 120 received, 12 shipped, 108 on hand; original values in import_backups ${backupId}. No quantities or order stages changed.`]);

    for (const table of SKU_TABLES) {
        if (table === 'inventory_transactions') continue;
        const oldCount = await count(client, `select count(*)::int n from ${table} where sku=$1`, [OLD_SKU]);
        assert(oldCount === 0, `${table} still has ${oldCount} old-SKU rows.`);
    }
    const stock = await rows(client,
        `select coalesce(sum(quantity),0)::int on_hand,count(*)::int lines,
                count(*) filter (where lot_number<>$3)::int bad_lot
         from inventory_lines where account_name=$1 and sku=$2`, [ACCOUNT, NEW_SKU, NEW_SKU]);
    assert(stock[0].on_hand === 108 && stock[0].lines === 45 && stock[0].bad_lot === 0,
        'Post-correction stock verification failed.');
    const ledger = await rows(client,
        `select coalesce(sum(quantity_delta),0)::int net,count(*)::int events,
                count(*) filter (where lot_number<>$3)::int bad_lot
         from inventory_transactions where account_name=$1 and sku=$2`, [ACCOUNT, NEW_SKU, NEW_SKU]);
    assert(ledger[0].net === 108 && ledger[0].events === 45 && ledger[0].bad_lot === 0,
        'Post-correction inventory ledger verification failed.');
    const oldLedger = await rows(client,
        `select coalesce(sum(quantity_delta),0)::int net,count(*)::int events
         from inventory_transactions where account_name=$1 and sku=$2`, [ACCOUNT, OLD_SKU]);
    assert(oldLedger[0].net === 0 && oldLedger[0].events === 260,
        'Original SKU ledger was not balanced to zero.');
    const receipt = await rows(client,
        `select count(*)::int lines,sum(received_quantity)::int pallets,
                count(*) filter (where lot_number<>$2 or sku<>$2)::int incorrect
         from portal_inbound_lines where inbound_id=any($1::bigint[])`, [IDS, NEW_SKU]);
    assert(receipt[0].lines === 6 && receipt[0].pallets === 120 && receipt[0].incorrect === 0,
        'Post-correction inbound verification failed.');
    const afterOrders = await rows(client,
        `select o.order_code,o.status,l.sku,l.requested_quantity
         from portal_order_lines l join portal_orders o on o.id=l.order_id
         where o.account_name=$1 and l.sku=$2 order by o.id`, [ACCOUNT, NEW_SKU]);
    assert(afterOrders.length === 7 && afterOrders.every(order =>
        before.orders.some(saved => saved.number === order.order_code && saved.status === order.status) &&
        Number(order.requested_quantity) === 4), 'Post-correction order verification failed.');
    return { backupId, ...before, correctedSku: NEW_SKU, correctedLot: NEW_SKU,
        correctedInventoryRows: 45, preservedHistoricalLedgerEvents: 215,
        reclassificationEvents: 90 };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    assert(connectionString, 'Production database connection unavailable.');
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    const applyChanges = process.argv.includes('apply');
    try {
        await client.query(applyChanges ? 'begin isolation level serializable' : 'begin read only');
        await client.query("set local lock_timeout='5s'");
        await client.query("set local statement_timeout='60s'");
        if (applyChanges) {
            const lock = await rows(client,
                'select pg_try_advisory_xact_lock(hashtext($1)) acquired',
                [`alcona-sku-lot:${OLD_SKU}:${NEW_SKU}`]);
            assert(lock[0].acquired, 'Another Alcona SKU correction is active.');
        }
        const before = await preflight(client);
        const backupPayload = await snapshot(client);
        for (const [table, expected] of Object.entries({
            ...EXPECTED_COUNTS, portal_inbounds: 6, portal_inbound_receipt_allocations: 9
        })) {
            assert(backupPayload[table].length === expected,
                `${table} backup snapshot has ${backupPayload[table].length} rows, expected ${expected}.`);
        }
        const result = applyChanges ? await apply(client, before, backupPayload) : { mode: 'PREFLIGHT', ...before };
        if (applyChanges) await client.query('commit');
        else await client.query('rollback');
        console.log(JSON.stringify(result));
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

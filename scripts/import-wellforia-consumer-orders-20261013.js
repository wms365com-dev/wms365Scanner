const crypto = require('node:crypto');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const ACCOUNT = 'WELLFORIA HEALTH INC';
const WAREHOUSE = 'GW3PL-MISS';
const REQUESTED_SHIP_DATE = '2026-10-13';
const ORDERS = [
  { reference: 'WF-CONS-20261013-001', name: 'PATEL DHAVAL', phone: '519-701-2462', email: 'DPATEL6664@GMAIL.COM', address1: '20 GLENWOOD CRES', city: 'HAMILTON', state: 'ON', postalCode: 'L9C 3J4', lines: [{ sku: 'WW-12PK-EA', quantity: 1 }] },
  { reference: 'WF-CONS-20261013-002', name: 'MARTINA VIOLO', phone: '647-573-1177', email: 'VIOLO151177@GMAIL.COM', address1: '1575 LEWES WAY', city: 'MISSISSAUGA', state: 'ON', postalCode: 'L4W 3S4', lines: [{ sku: 'WW-12PK-EA', quantity: 1 }] },
  { reference: 'WF-CONS-20261013-003', name: 'ANNA OKASHIMO', phone: '647-500-6754', email: 'ANNA.OKASHIMO@GMAIL.COM', address1: '327 BESSBOROUGH DR.', city: 'TORONTO', state: 'ON', postalCode: 'M4G 3K9', lines: [{ sku: 'WW-12PK-EA', quantity: 1 }] },
  { reference: 'WF-CONS-20261013-004', name: 'SHREYA SHAH', phone: '587-919-7058', email: 'SHREYA.SNSSJ@GMAIL.COM', address1: '635, 8 TELEGRAM MEWS', city: 'TORONTO', state: 'ON', postalCode: 'M5V 3Z5', lines: [{ sku: 'WW-12PK-EA', quantity: 1 }, { sku: 'WW-6PK-EA', quantity: 1 }] },
  { reference: 'WF-CONS-20261013-005', name: 'SHAGUFTA KAUSAR', phone: '289-828-3097', email: 'SHAGUFTAKAUSAR5@GMAIL.COM', address1: '5988 BLUE SPRUCE AVENUE', city: 'BURLINGTON', state: 'ON', postalCode: 'L7L 6T9', lines: [{ sku: 'WW-12PK-EA', quantity: 1 }] },
];

function key(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (!APPLY) await client.query('set transaction read only');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['wellforia-consumer-import:20261013-5']);
    const account = await client.query('select name,is_active from owner_accounts where name=$1', [ACCOUNT]);
    const warehouse = await client.query(`select fl.id,fl.code,fl.is_active,cfl.allow_storage
      from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
      where cfl.account_name=$1 and fl.code=$2`, [ACCOUNT, WAREHOUSE]);
    const skus = [...new Set(ORDERS.flatMap((order) => order.lines.map((line) => line.sku)))];
    const items = await client.query(`select sku,description,tracking_level,unit_uom,units_per_case,blocked
      from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`, [ACCOUNT, skus]);
    if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error('Exact active Wellforia tenant verification failed.');
    if (warehouse.rowCount !== 1 || warehouse.rows[0].is_active !== true || warehouse.rows[0].allow_storage !== true) throw new Error('Exact active Mississauga warehouse verification failed.');
    if (items.rowCount !== skus.length || items.rows.some((item) => item.blocked)) throw new Error('Required Wellforia item verification failed.');
    const references = ORDERS.map((order) => order.reference);
    const duplicateRefs = await client.query(`select order_code,po_number,status from portal_orders
      where account_name=$1 and (upper(po_number)=any($2::text[]) or upper(shipping_reference)=any($2::text[]))`, [ACCOUNT, references]);
    if (duplicateRefs.rowCount) throw new Error(`Existing references block import: ${duplicateRefs.rows.map((row) => row.order_code).join(', ')}`);
    const recent = await client.query(`select o.order_code,o.status,o.ship_to_name,o.ship_to_phone,o.ship_to_address1,
      o.ship_to_postal_code,array_agg(l.sku||':'||l.requested_quantity order by l.line_number) lines
      from portal_orders o join portal_order_lines l on l.order_id=o.id
      where o.account_name=$1 and o.created_at>=now()-interval '45 days'
      group by o.id`, [ACCOUNT]);
    const duplicates = ORDERS.flatMap((order, index) => {
      const expected = order.lines.map((line) => `${line.sku}:${line.quantity}`);
      const found = recent.rows.find((row) => key(row.ship_to_name) === key(order.name)
        && key(row.ship_to_phone) === key(order.phone) && key(row.ship_to_address1) === key(order.address1)
        && key(row.ship_to_postal_code) === key(order.postalCode)
        && JSON.stringify(row.lines) === JSON.stringify(expected));
      return found ? [{ row: index + 1, orderCode: found.order_code, status: found.status }] : [];
    });
    const replacementForByRow = new Map(duplicates.map((duplicate) => [duplicate.row, duplicate.orderCode]));
    const demand = Object.fromEntries(skus.map((sku) => [sku, ORDERS.flatMap((o) => o.lines).filter((l) => l.sku === sku).reduce((sum, l) => sum + l.quantity, 0)]));
    const available = await client.query(`select sku,coalesce(sum(quantity),0)::numeric available
      from inventory_lines where account_name=$1 and sku=any($2::text[]) group by sku order by sku`, [ACCOUNT, skus]);
    const summary = { mode: APPLY ? 'APPLY' : 'PREFLIGHT', account: ACCOUNT, warehouse: WAREHOUSE,
      requestedShipDate: REQUESTED_SHIP_DATE, orderCount: ORDERS.length, lineCount: ORDERS.reduce((sum, o) => sum + o.lines.length, 0),
      demand, replacementMatches: duplicates, items: items.rows, available: available.rows };
    if (!APPLY) {
      await client.query('rollback');
      console.log(JSON.stringify(summary));
      return;
    }
    const created = [];
    for (let orderIndex = 0; orderIndex < ORDERS.length; orderIndex += 1) {
      const order = ORDERS[orderIndex];
      const replacementFor = replacementForByRow.get(orderIndex + 1);
      const notes = `Owner-authorized Wellforia replacement consumer order${replacementFor ? ` for ${replacementFor}` : ''} | requested carrier UPS | tracking not yet assigned | consumer email ${order.email}`;
      const inserted = await client.query(`insert into portal_orders (
        account_name,status,po_number,shipping_reference,contact_name,contact_phone,requested_ship_date,
        order_type,shipment_method,order_notes,ship_to_name,ship_to_address1,ship_to_city,ship_to_state,
        ship_to_postal_code,ship_to_country,ship_to_phone,fulfillment_location_id,ship_to_address_status
      ) values ($1,'DRAFT',$2,$2,$3,$4,$5,'B2C_ONLINE','PARCEL',$6,$3,$7,$8,$9,$10,'CA',$4,$11,'SAVED') returning id`,
      [ACCOUNT, order.reference, order.name, order.phone, REQUESTED_SHIP_DATE, notes, order.address1,
        order.city, order.state, order.postalCode, warehouse.rows[0].id]);
      const id = inserted.rows[0].id;
      const orderCode = `ORD-${String(id).padStart(6, '0')}`;
      await client.query('update portal_orders set order_code=$2,updated_at=now() where id=$1', [id, orderCode]);
      for (let index = 0; index < order.lines.length; index += 1) {
        const line = order.lines[index];
        await client.query(`insert into portal_order_lines(order_id,line_number,sku,requested_quantity)
          values($1,$2,$3,$4)`, [id, index + 1, line.sku, line.quantity]);
      }
      created.push({ orderCode, reference: order.reference, lines: order.lines });
    }
    await client.query('commit');
    const verified = await pool.query(`select o.order_code,o.status,o.po_number,o.shipment_method,o.fulfillment_location_id,
      array_agg(l.sku||':'||l.requested_quantity order by l.line_number) lines
      from portal_orders o join portal_order_lines l on l.order_id=o.id
      where o.account_name=$1 and o.po_number=any($2::text[]) group by o.id order by o.id`, [ACCOUNT, references]);
    if (verified.rowCount !== ORDERS.length || verified.rows.some((row) => row.status !== 'DRAFT'
      || row.shipment_method !== 'PARCEL' || String(row.fulfillment_location_id) !== String(warehouse.rows[0].id))) {
      throw new Error('Post-commit verification failed; manual review is required.');
    }
    console.log(JSON.stringify({ ...summary, created, verifiedCount: verified.rowCount,
      sideEffects: { released: 0, allocated: 0, emailed: 0, printed: 0, trackingAssigned: 0 } }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release(); await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

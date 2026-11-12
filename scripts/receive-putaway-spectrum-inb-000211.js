"use strict";

const { Client } = require("pg");
const { APP_USER_ROLES, updateAdminPortalInboundStatus } = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "INB-000211";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const ACCOUNT_ID = "3918";
const WAREHOUSE_ID = 258;
const WAREHOUSE_CODE = "GW3PL-MEADOWPINE";
const REFERENCE = "GW1312/26";
const RECEIPT_DATE = "2026-11-04";
const DESTINATION = "GW3PL-MEADOWPINE-RECEIVING";
const SKU = "SPECTRUM BLUE 15:4 CCS";
const LOT = "CC-26-8213-07";
const QUANTITY = 100;
const PALLETS = 2;
const BAGS_PER_PALLET = 50;
const PALLET_WEIGHT_KG = 1000;
const ACTOR = {
  id: null,
  email: "operations@wms365.co",
  full_name: "WMS365 Owner-Approved Inbound",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  let committed = false;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-RECEIVE-PUTAWAY`]);
    const account = await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
      throw new Error("Spectrum account identity mismatch.");
    }
    const inboundResult = await db.query(
      `select i.id,i.status,i.account_name,i.reference_number,i.fulfillment_location_id,
              i.received_at,fl.code warehouse_code
         from portal_inbounds i join fulfillment_locations fl on fl.id=i.fulfillment_location_id
        where i.inbound_code=$1 for update`,
      [CODE]
    );
    if (inboundResult.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
    const inbound = inboundResult.rows[0];
    if (inbound.account_name !== ACCOUNT || inbound.reference_number !== REFERENCE
      || Number(inbound.fulfillment_location_id) !== WAREHOUSE_ID
      || inbound.warehouse_code !== WAREHOUSE_CODE) {
      throw new Error("Inbound company, reference, or warehouse scope changed.");
    }
    const assignment = await db.query(
      `select fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
         from fulfillment_locations fl join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
        where fl.id=$2 and fl.code=$3`,
      [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    const assigned = assignment.rows[0];
    if (assignment.rowCount !== 1 || !assigned.is_active || !assigned.allow_inbound
      || !assigned.allow_outbound || !assigned.allow_storage || !assigned.customer_portal_visible) {
      throw new Error("Spectrum Meadowpine warehouse assignment is not fully enabled.");
    }
    const lineResult = await db.query(
      `select l.id,l.sku,l.expected_quantity,l.received_quantity,c.description,c.upc,
              c.tracking_level,c.lot_tracked,c.expiration_tracked,c.blocked,c.item_type
         from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
        where l.inbound_id=$1 for update of l`,
      [inbound.id, ACCOUNT]
    );
    if (lineResult.rowCount !== 1) throw new Error("Inbound line count changed.");
    const line = lineResult.rows[0];
    if (line.sku !== SKU || Number(line.expected_quantity) !== QUANTITY || line.received_quantity != null
      || line.tracking_level !== "UNIT" || !line.lot_tracked || line.expiration_tracked
      || line.blocked || line.item_type !== "INVENTORY") {
      throw new Error("Inbound line or item-master setup changed.");
    }
    const document = await db.query(
      `select count(*)::integer count from portal_inbound_documents
        where inbound_id=$1 and document_category='SHIPMENT_PACKING_SLIP'
          and file_name='GW-1312-26.pdf'`,
      [inbound.id]
    );
    const priorLedger = await db.query(
      `select count(*)::integer count from inventory_transactions
        where source_type='PORTAL_INBOUND' and source_id=$1::text`,
      [String(inbound.id)]
    );
    const priorAllocations = await db.query(
      "select count(*)::integer count from portal_inbound_receipt_allocations where inbound_id=$1",
      [inbound.id]
    );
    const priorLabels = await db.query(
      "select count(*)::integer count from portal_inbound_pallet_labels where inbound_id=$1",
      [inbound.id]
    );
    if (inbound.status === "PUTAWAY_COMPLETE" && inbound.received_at) {
      const saved = await db.query(
        `select to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date
           from portal_inbounds where id=$1`,
        [inbound.id]
      );
      await db.query("rollback");
      return console.log(JSON.stringify({ outcome: "already_received", applied: false,
        inbound: CODE, receiptDate: saved.rows[0].receipt_date }));
    }
    if (inbound.status !== "SUBMITTED" || inbound.received_at
      || Number(document.rows[0].count) !== 1
      || Number(priorLedger.rows[0].count) !== 0
      || Number(priorAllocations.rows[0].count) !== 0
      || Number(priorLabels.rows[0].count) !== 0) {
      throw new Error("Inbound is not in a clean receivable state.");
    }
    const bin = await db.query(
      `select account_name,fulfillment_location_id,location_type,is_pickable
         from bin_locations where code=$1 for update`,
      [DESTINATION]
    );
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT
      || Number(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID
      || bin.rows[0].location_type !== "STORAGE" || !bin.rows[0].is_pickable) {
      throw new Error("Spectrum pickable Meadowpine location mismatch.");
    }
    const beforeStock = await db.query(
      `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
        where account_name=$1 and location=$2 and sku=$3 and lot_number=$4`,
      [ACCOUNT, DESTINATION, SKU, LOT]
    );
    console.log(JSON.stringify({ phase: "preflight", inbound: CODE, account: ACCOUNT,
      warehouse: WAREHOUSE_CODE, status: inbound.status, receiptDate: RECEIPT_DATE,
      sku: SKU, lot: LOT, quantity: QUANTITY, pallets: PALLETS,
      bagsPerPallet: BAGS_PER_PALLET, pickableLocation: DESTINATION }));
    if (!APPLY) {
      await db.query("rollback");
      return;
    }

    for (let index = 1; index <= PALLETS; index += 1) {
      const palletCode = `GW131226-P${String(index).padStart(2, "0")}`;
      const label = await db.query(
        `insert into portal_inbound_pallet_labels
          (inbound_id,line_id,pallet_code,account_name,sku,upc,description,cases_on_pallet,
           expected_quantity,pallet_type,pallet_status,is_mixed,billable,pallet_size_type,
           pallet_length_inches,pallet_width_inches,pallet_height_inches,pallet_size_note,
           label_date,created_by,notes)
         values($1,$2,$3,$4,$5,$6,$7,$8,$8,'SINGLE_SKU','PLANNED',false,true,
                'STANDARD_40_48_55',40,48,55,'',$9,$10,$11)
         returning id`,
        [inbound.id, line.id, palletCode, ACCOUNT, SKU, line.upc || "", line.description,
          BAGS_PER_PALLET, RECEIPT_DATE, ACTOR.full_name,
          `${BAGS_PER_PALLET} bags x 20 kg; ${PALLET_WEIGHT_KG} kg; lot ${LOT}.`]
      );
      await db.query(
        `insert into portal_inbound_pallet_label_contents
          (pallet_label_id,inbound_id,line_id,sku,quantity,lot_number,expiration_date)
         values($1,$2,$3,$4,$5,$6,null)`,
        [label.rows[0].id, inbound.id, line.id, SKU, BAGS_PER_PALLET, LOT]
      );
    }
    let state = await updateAdminPortalInboundStatus(db, inbound.id, "ARRIVED", ACTOR, {
      note: `Physically received ${RECEIPT_DATE}; two pallets confirmed by owner.`,
    });
    state = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
      receivingLocation: DESTINATION,
      receivingLines: Array.from({ length: PALLETS }, (_, index) => ({
        id: line.id,
        sku: SKU,
        receivedQuantity: BAGS_PER_PALLET,
        receivedLocation: DESTINATION,
        lotNumber: LOT,
        palletReference: `GW131226-P${String(index + 1).padStart(2, "0")}`,
        palletSizeType: "STANDARD_40_48_55",
        palletWeight: PALLET_WEIGHT_KG,
        palletWeightUom: "KG",
      })),
      note: "Full 100 bags received as two physical pallets per owner instruction.",
    });
    if (state.status !== "RECEIVED_PENDING_PUTAWAY") {
      throw new Error(`Receipt reached ${state.status}, not pending putaway.`);
    }
    state = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
      note: `Two pallets / ${QUANTITY} bags put away to ${DESTINATION}; inventory is pickable.`,
    });
    await db.query(
      `update portal_inbound_lines
          set pallet_count=$2,pallet_codes=$3,updated_at=now()
        where id=$1`,
      [line.id, PALLETS, "GW131226-P01, GW131226-P02"]
    );
    await db.query(
      `update portal_inbounds
          set arrived_at=($2::date + time '12:00') at time zone 'America/Toronto',
              received_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now()
        where id=$1`,
      [inbound.id, RECEIPT_DATE]
    );
    await db.query(
      `update portal_inbound_pallet_labels set label_date=$2::date,
              confirmed_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now()
        where inbound_id=$1`,
      [inbound.id, RECEIPT_DATE]
    );
    await db.query(
      `update billing_events set service_date=$3::date,updated_at=now()
        where account_name=$1 and source_type='INBOUND_RECEIPT' and source_ref=$2 and status<>'VOID'`,
      [ACCOUNT, CODE, RECEIPT_DATE]
    );
    const head = await db.query(`select status,to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') receipt_date
                                  from portal_inbounds where id=$1`, [inbound.id]);
    const receivedLine = await db.query(`select received_quantity,received_location,lot_number,pallet_count,pallet_codes
                                           from portal_inbound_lines where id=$1`, [line.id]);
    const labels = await db.query(`select count(*)::integer count,sum(actual_quantity)::integer quantity,
                                          count(*) filter(where pallet_status='RECEIVED')::integer received
                                     from portal_inbound_pallet_labels where inbound_id=$1`, [inbound.id]);
    const allocations = await db.query(`select count(*)::integer count,sum(quantity)::integer quantity,
                                               count(distinct pallet_reference)::integer pallets
                                          from portal_inbound_receipt_allocations where inbound_id=$1`, [inbound.id]);
    const ledger = await db.query(`select count(*)::integer count,sum(quantity_delta)::integer quantity
                                     from inventory_transactions where source_type='PORTAL_INBOUND'
                                      and source_id=$1::text and transaction_type='RECEIVING'`, [String(inbound.id)]);
    const afterStock = await db.query(`select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                                        where account_name=$1 and location=$2 and sku=$3 and lot_number=$4`,
      [ACCOUNT, DESTINATION, SKU, LOT]);
    const savedLine = receivedLine.rows[0];
    const savedLabels = labels.rows[0];
    const savedAllocations = allocations.rows[0];
    const savedLedger = ledger.rows[0];
    console.log(JSON.stringify({ phase: "postwrite-verification", head: head.rows[0],
      line: savedLine, labels: savedLabels, allocations: savedAllocations, ledger: savedLedger,
      stockBefore: Number(beforeStock.rows[0].quantity), stockAfter: Number(afterStock.rows[0].quantity) }));
    if (head.rows[0].status !== "PUTAWAY_COMPLETE" || head.rows[0].receipt_date !== RECEIPT_DATE
      || Number(savedLine.received_quantity) !== QUANTITY || savedLine.received_location !== DESTINATION
      || savedLine.lot_number !== LOT || Number(savedLine.pallet_count) !== PALLETS
      || Number(savedLabels.count) !== PALLETS || Number(savedLabels.received) !== PALLETS
      || Number(savedLabels.quantity) !== QUANTITY || Number(savedAllocations.count) !== PALLETS
      || Number(savedAllocations.quantity) !== QUANTITY || Number(savedAllocations.pallets) !== PALLETS
      || Number(savedLedger.count) !== PALLETS || Number(savedLedger.quantity) !== QUANTITY
      || Number(afterStock.rows[0].quantity) - Number(beforeStock.rows[0].quantity) !== QUANTITY) {
      throw new Error("Post-receipt inventory verification failed.");
    }
    await db.query("commit");
    committed = true;
    console.log(JSON.stringify({ phase: "verified", outcome: "received_and_pickable",
      inbound: CODE, account: ACCOUNT, warehouse: WAREHOUSE_CODE, status: head.rows[0].status,
      receiptDate: RECEIPT_DATE, sku: SKU, lot: LOT, receivedQuantity: QUANTITY,
      pallets: PALLETS, bagsPerPallet: BAGS_PER_PALLET, pickableLocation: DESTINATION }));
  } catch (error) {
    if (!committed) await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

const fs = require("fs");
const { Pool } = require("pg");

const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const JSON_PATH = process.argv[2];

if (!JSON_PATH) throw new Error("Source JSON path is required.");

const rows = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const skuCandidates = [...new Set(rows.flatMap((row) => [row.SKU, row["Source Item Code"]]).filter(Boolean))];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function normalize(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    const account = await client.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
    const warehouse = await client.query("select id,code,name,is_active from fulfillment_locations where id=$1", [WAREHOUSE_ID]);
    const catalog = await client.query(
        `select sku,description,upc,tracking_level,uom_label,unit_uom,units_per_case,
                lot_tracked,expiration_tracked,blocked,item_type,item_category
           from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
        [ACCOUNT, skuCandidates],
      );
    const inventory = await client.query(
        `select i.sku,fl.id warehouse_id,fl.code warehouse_code,count(*)::integer as line_count,
                coalesce(sum(quantity),0)::numeric as on_hand
           from inventory_lines i
           left join bin_locations b on b.code=i.location
           left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
          where i.account_name=$1 and i.sku=any($2::text[])
          group by i.sku,fl.id,fl.code order by i.sku,fl.id`,
        [ACCOUNT, skuCandidates],
      );
    const inboundHistory = await client.query(
      `select i.id,i.inbound_code,i.status,i.reference_number,i.expected_date::text,
              i.received_at::text,fl.code warehouse_code,
              count(l.id)::integer line_count,
              coalesce(sum(l.expected_quantity),0)::numeric expected_quantity,
              coalesce(sum(l.received_quantity),0)::numeric received_quantity
         from portal_inbounds i
         left join portal_inbound_lines l on l.inbound_id=i.id
         left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
        where i.account_name=$1 and (
          upper(coalesce(i.reference_number,'')) like '%SHP079126%'
          or upper(coalesce(i.reference_number,'')) like '%HLBU2653396%'
          or upper(coalesce(i.notes,'')) like '%SHP079126%'
          or upper(coalesce(i.notes,'')) like '%HLBU2653396%'
          or (i.received_at::date between date '2026-06-01' and date '2026-07-31')
        )
        group by i.id,i.inbound_code,i.status,i.reference_number,i.expected_date,i.received_at,fl.code
        order by i.received_at,i.id`,
      [ACCOUNT],
    );
    const receiptLedger = await client.query(
      `select coalesce(pi.inbound_code,t.source_id) source,
              min(t.server_timestamp)::text first_transaction,
              count(*)::integer line_count,
              coalesce(sum(t.quantity_delta),0)::numeric quantity_delta
         from inventory_transactions t
         left join portal_inbounds pi on t.source_type='PORTAL_INBOUND' and pi.id::text=t.source_id
        where t.account_name=$1 and t.transaction_type='RECEIVING'
          and t.sku=any($2::text[])
          and t.server_timestamp::date between date '2026-06-01' and date '2026-07-31'
        group by coalesce(pi.inbound_code,t.source_id)
        order by first_transaction`,
      [ACCOUNT, skuCandidates],
    );
    const candidateLines = await client.query(
      `select i.inbound_code,l.line_number,l.sku,l.expected_quantity,l.received_quantity,l.received_location
         from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
        where i.account_name=$1 and i.inbound_code='INB-000121'
        order by l.line_number,l.id`,
      [ACCOUNT],
    );

    const catalogBySku = new Map(catalog.rows.map((row) => [row.sku, row]));
    const duplicates = rows.filter((row, index) => rows.findIndex((other) => other.SKU === row.SKU) !== index).map((row) => row.SKU);
    const comparisons = rows.map((source) => {
      const item = catalogBySku.get(source.SKU) || catalogBySku.get(source["Source Item Code"]) || null;
      const expectedUom = source.UOM === "CARTON" ? "CASE" : source.UOM;
      const descriptionMatch = item ? normalize(item.description) === normalize(source.Description) : false;
      const uomMatch = item ? (
        source.UOM === "CARTON"
          ? item.tracking_level === "CASE"
          : item.tracking_level === "UNIT" || String(item.unit_uom || "").toUpperCase() === expectedUom
      ) : false;
      return {
        sku: source.SKU,
        sourceItemCode: source["Source Item Code"],
        sourceDescription: source.Description,
        expectedQuantity: Number(source["Expected Quantity"]),
        sourceUom: source.UOM,
        exists: Boolean(item),
        descriptionMatch,
        uomMatch,
        catalog: item,
      };
    });

    console.log(JSON.stringify({
      scope: {
        account: account.rows,
        expectedAccount: ACCOUNT,
        warehouse: warehouse.rows,
        expectedWarehouse: { id: WAREHOUSE_ID, code: WAREHOUSE_CODE },
      },
      source: {
        rowCount: rows.length,
        duplicateSkus: [...new Set(duplicates)],
        expectedCartons: rows.filter((row) => row.UOM === "CARTON").reduce((sum, row) => sum + Number(row["Expected Quantity"]), 0),
        expectedUnits: rows.filter((row) => row.UOM === "UNIT").reduce((sum, row) => sum + Number(row["Expected Quantity"]), 0),
      },
      summary: {
        catalogMatches: comparisons.filter((row) => row.exists).length,
        missingSkus: comparisons.filter((row) => !row.exists).map((row) => row.sku),
        descriptionMismatches: comparisons.filter((row) => row.exists && !row.descriptionMatch).map((row) => row.sku),
        uomMismatches: comparisons.filter((row) => row.exists && !row.uomMatch).map((row) => row.sku),
        blockedSkus: comparisons.filter((row) => row.catalog?.blocked).map((row) => row.sku),
      },
      exceptions: comparisons.filter((row) => !row.exists || !row.uomMatch || row.catalog?.blocked),
      inboundHistory: inboundHistory.rows,
      receiptLedger: receiptLedger.rows,
      candidateInboundLines: candidateLines.rows,
      currentInventorySummary: {
        matchedSkusAtMississauga: new Set(inventory.rows.filter((row) => Number(row.warehouse_id) === WAREHOUSE_ID).map((row) => row.sku)).size,
        matchedSkusAtOtherWarehouses: [...new Set(inventory.rows.filter((row) => Number(row.warehouse_id) !== WAREHOUSE_ID).map((row) => row.sku))],
      },
    }, null, 2));
    await client.query("rollback");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});

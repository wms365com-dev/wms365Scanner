const { Client } = require('pg');

const ACCOUNT = 'ALCONA TRADING LTD';
const SKU = 'MS26062403';
const OLD_SKU = 'MS26060402G';
const BACKUP_ID = 5;
const DELIVERY_KEY = 'owner-alcona-six-container-sku-lot-correction-prathab-20261005-v1';
const FROM = 'WMS365 <support@wms365.co>';
const TO = ['Prathab@greywolf3pl.com'];
const SUBJECT = 'Alcona SKU and batch correction complete - six HPXU containers';
const CONTAINERS = ['HPXU104658', 'HPXU104646', 'HPXU104656',
    'HPXU104693', 'HPXU104781', 'HPXU104846'];

async function main() {
    if (!process.env.RESEND_API_KEY) throw new Error('Email provider unavailable.');
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Production database unavailable.');
    const db = new Client({ connectionString, ssl: false });
    await db.connect();
    let logId;
    try {
        await db.query('begin');
        try {
            const prior = await db.query(
                'select id,status,message_id from email_delivery_log where delivery_key=$1 for update',
                [DELIVERY_KEY]);
            if (prior.rowCount) {
                if (prior.rows[0].status === 'SENT') {
                    await db.query('rollback');
                    console.log(JSON.stringify({ alreadySent: true, messageId: prior.rows[0].message_id }));
                    return;
                }
                throw new Error('Prior email attempt requires review; refusing duplicate send.');
            }

            const backup = await db.query(
                `select backup_payload->'scope' as scope from import_backups
                 where id=$1 and backup_type='ALCONA_SKU_LOT_CORRECTION'`, [BACKUP_ID]);
            if (backup.rowCount !== 1 || backup.rows[0].scope?.account !== ACCOUNT ||
                backup.rows[0].scope?.oldSku !== OLD_SKU || backup.rows[0].scope?.newSku !== SKU ||
                backup.rows[0].scope?.inboundIds?.length !== 6) {
                throw new Error('Audited correction backup identity mismatch.');
            }
            const receipts = await db.query(
                `select i.reference_number,l.sku,l.lot_number,l.received_quantity
                 from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
                 where i.account_name=$1 and i.id=any($2::bigint[])
                   and i.fulfillment_location_id=143 and i.status='PUTAWAY_COMPLETE'`,
                [ACCOUNT, backup.rows[0].scope.inboundIds]);
            if (receipts.rowCount !== 6 || receipts.rows.some(row =>
                !CONTAINERS.includes(row.reference_number) || row.sku !== SKU ||
                row.lot_number !== SKU || Number(row.received_quantity) !== 20)) {
                throw new Error('Live six-container receipt verification failed.');
            }
            const item = await db.query(
                'select tracking_level,lot_tracked from item_catalog where account_name=$1 and sku=$2',
                [ACCOUNT, SKU]);
            if (item.rowCount !== 1 || item.rows[0].tracking_level !== 'PALLET' ||
                item.rows[0].lot_tracked !== true) throw new Error('Corrected item master missing.');
            const stock = await db.query(
                `select coalesce(sum(quantity),0)::int on_hand
                 from inventory_lines where account_name=$1 and sku=$2 and lot_number=$2`,
                [ACCOUNT, SKU]);
            const ledger = await db.query(
                `select sku,coalesce(sum(quantity_delta),0)::int net
                 from inventory_transactions where account_name=$1 and sku in ($2,$3)
                 group by sku`, [ACCOUNT, SKU, OLD_SKU]);
            const balances = new Map(ledger.rows.map(row => [row.sku, row.net]));
            if (Number(stock.rows[0].on_hand) !== balances.get(SKU) || balances.get(OLD_SKU) !== 0) {
                throw new Error('Live inventory and ledger balances diverged.');
            }

            const claim = await db.query(
                `insert into email_delivery_log
                 (status,provider,from_address,to_addresses,cc_addresses,bcc_addresses,reply_to,
                  subject,account_name,source_type,source_ref,delivery_key,metadata)
                 values ('PENDING','RESEND',$1,$2::jsonb,'[]'::jsonb,'[]'::jsonb,$3,
                         $4,$5,'ITEM_SKU_LOT_CORRECTION',$6,$7,$8::jsonb)
                 on conflict (delivery_key) do nothing returning id`,
                [FROM, JSON.stringify(TO), 'support@wms365.co', SUBJECT, ACCOUNT,
                    String(BACKUP_ID), DELIVERY_KEY,
                    JSON.stringify({ oldSku: OLD_SKU, newSku: SKU, lot: SKU,
                        containerCount: 6, receivedPallets: 120, onHandAtSend: stock.rows[0].on_hand })]);
            if (claim.rowCount !== 1) throw new Error('Email idempotency claim failed.');
            logId = claim.rows[0].id;
            await db.query('commit');
        } catch (error) {
            await db.query('rollback').catch(() => {});
            throw error;
        }

        const body = [
            'Hi Prathab,', '',
            'The Alcona WMS365 correction is complete. These six containers are now recorded under both SKU and batch/lot MS26062403:',
            ...CONTAINERS.map(container => `- ${container}`), '',
            'Each container has 20 pallets received, for 120 pallets total. At the time of correction, 12 pallets had shipped and 108 remained on hand; 16 of the on-hand pallets were allocated to open orders.',
            'The item master, receipts, pallet-label records, on-hand inventory, open allocations, and affected order and shipment lines were corrected. The original append-only inventory events were preserved, with balanced reclassification entries and an audit backup. Quantities, order statuses, and billing were not changed.',
            'Previously printed physical labels and attached historical PDFs do not change automatically. Please reprint or reissue any that are still in use and show the former SKU.',
            '', 'Regards,', 'WMS365 Support'
        ].join('\n');
        const response = await fetch(`${(process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': DELIVERY_KEY
            },
            body: JSON.stringify({ from: FROM, to: TO, reply_to: 'support@wms365.co',
                subject: SUBJECT, text: body }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id) {
            await db.query(
                `update email_delivery_log set status='FAILED',error_message=$2,
                    failed_at=now(),updated_at=now() where id=$1`,
                [logId, `Provider rejected correction email (${response.status})`]);
            throw new Error(`Email provider did not accept the message (${response.status}).`);
        }
        await db.query(
            `update email_delivery_log set status='SENT',message_id=$2,
                provider_response=$3,sent_at=now(),updated_at=now() where id=$1`,
            [logId, payload.id, 'Resend accepted Alcona correction notice']);
        const verified = await db.query(
            `select status,message_id,to_addresses from email_delivery_log where id=$1`, [logId]);
        if (verified.rowCount !== 1 || verified.rows[0].status !== 'SENT' ||
            verified.rows[0].message_id !== payload.id ||
            JSON.stringify(verified.rows[0].to_addresses) !== JSON.stringify(TO)) {
            throw new Error('Provider accepted email but WMS delivery verification failed.');
        }
        console.log(JSON.stringify({ sent: true, to: TO[0], messageId: payload.id,
            deliveryLogId: logId, subject: SUBJECT }));
    } finally {
        await db.end();
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

const { Pool } = require("pg");

const APPLY_CONFIRMATION = "APPLY-SAFE-BIN-OWNERSHIP";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_PRIVATE_URL or DATABASE_URL is required.");
    const apply = process.argv.includes(`--confirm=${APPLY_CONFIRMATION}`);
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        const candidates = await client.query(`
            with inventory_owners as (
                select location,
                       min(account_name) as inventory_owner,
                       count(distinct account_name)::integer as owner_count
                from inventory_lines
                where quantity <> 0
                group by location
            ), warehouse_candidates as (
                select io.location,
                       io.inventory_owner,
                       fl.id as fulfillment_location_id,
                       fl.code as fulfillment_location_code,
                       count(*) over (partition by io.location)::integer as company_warehouse_count,
                       count(*) filter (
                           where io.location = fl.code or io.location like fl.code || '-%'
                       ) over (partition by io.location)::integer as prefix_match_count,
                       row_number() over (
                           partition by io.location
                           order by
                               case when io.location = fl.code or io.location like fl.code || '-%' then 0 else 1 end,
                               length(fl.code) desc,
                               fl.id
                       ) as candidate_rank
                from inventory_owners io
                join company_fulfillment_locations cfl on cfl.account_name = io.inventory_owner
                join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id and fl.is_active = true
                where io.owner_count = 1
            ), safe_assignments as (
                select wc.location,
                       wc.inventory_owner,
                       wc.fulfillment_location_id,
                       wc.fulfillment_location_code,
                       case
                           when wc.company_warehouse_count = 1 then 'SOLE_COMPANY_WAREHOUSE'
                           when wc.prefix_match_count = 1 then 'UNIQUE_WAREHOUSE_PREFIX'
                       end as evidence
                from warehouse_candidates wc
                where wc.candidate_rank = 1
                  and (wc.company_warehouse_count = 1 or wc.prefix_match_count = 1)
            )
            select b.id, b.code, sa.inventory_owner, sa.fulfillment_location_id,
                   sa.fulfillment_location_code, sa.evidence
            from bin_locations b
            join safe_assignments sa on sa.location = b.code
            where btrim(coalesce(b.account_name, '')) = ''
              and b.fulfillment_location_id is null
            order by b.code
            for update of b
        `);

        let updatedCount = 0;
        if (apply) {
            for (const row of candidates.rows) {
                const result = await client.query(`
                    update bin_locations b
                    set account_name = $1,
                        fulfillment_location_id = $2,
                        updated_at = now()
                    where b.id = $3
                      and btrim(coalesce(b.account_name, '')) = ''
                      and b.fulfillment_location_id is null
                      and not exists (
                          select 1 from inventory_lines il
                          where il.location = b.code
                            and il.quantity <> 0
                            and il.account_name <> $1
                      )
                    returning b.id
                `, [row.inventory_owner, row.fulfillment_location_id, row.id]);
                updatedCount += result.rowCount;
            }
            await client.query("commit");
        } else {
            await client.query("rollback");
        }

        console.log(JSON.stringify({
            mode: apply ? "APPLY" : "DRY_RUN",
            safeCandidateCount: candidates.rowCount,
            updatedCount,
            byEvidence: candidates.rows.reduce((counts, row) => {
                counts[row.evidence] = (counts[row.evidence] || 0) + 1;
                return counts;
            }, {})
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});

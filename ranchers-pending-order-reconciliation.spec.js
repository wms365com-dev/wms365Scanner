'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {isPendingCanadian,preparePreorder}=require('./scripts/reconcile-ranchers-shopify-orders');
const order={shipping_address:{country_code:'CA'},line_items:[{product_id:10349591724333,variant_id:52353121681709,
    title:"PREORDER - Rancher's Salt & Vinegar",variant_title:'12 Pack',sku:'',quantity:1,fulfillable_quantity:1,requires_shipping:true}]};
test('pending reconciliation excludes other countries, cancellations, completed and nonphysical lines',()=>{
    assert.equal(isPendingCanadian(order),true);
    assert.equal(isPendingCanadian({...order,shipping_address:{country_code:'US'}}),false);
    assert.equal(isPendingCanadian({...order,cancelled_at:'2026-09-01'}),false);
    assert.equal(isPendingCanadian({...order,closed_at:'2026-09-01'}),false);
    assert.equal(isPendingCanadian({...order,fulfillment_status:'fulfilled'}),false);
    assert.equal(isPendingCanadian({...order,line_items:[{...order.line_items[0],requires_shipping:false}]}),false);
});
test('reviewed preorder variant maps to distinct bags and preserves source payload',()=>{
    const mapped=preparePreorder(order);
    assert.equal(mapped.line_items[0].sku,'RTC-SV-EA');
    assert.equal(mapped.line_items[0].fulfillable_quantity,12);
    assert.equal(order.line_items[0].sku,'');
    assert.equal(order.line_items[0].fulfillable_quantity,1);
    assert.throws(()=>preparePreorder({...order,line_items:[{...order.line_items[0],variant_id:1}]}),/UNREVIEWED/);
    assert.throws(()=>preparePreorder({...order,line_items:[{...order.line_items[0],sku:'12-Pack'}]}),/UNREVIEWED/);
});

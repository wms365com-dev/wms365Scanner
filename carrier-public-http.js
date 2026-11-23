"use strict";

const cheerio = require("cheerio");
const {normalizeTrackingCarrier}=require("./carrier-tracking");
const {buildPublicTrackingUrl,normalizePublicTracking}=require("./carrier-public-tracking");
const MAX_HTML=2*1024*1024;
const CANPAR_API="https://canship.canpar.com/api/CanparAddons/trackByBarcodeV2";
const MAX_COOLDOWN=24*60*60*1000;
function retryAfterMs(value, now, fallback) {
    const text=String(value || "").trim();
    const milliseconds=/^\d+$/.test(text) ? Number(text)*1000 : Date.parse(text)-now;
    return Number.isFinite(milliseconds) && milliseconds>0 ? Math.min(MAX_COOLDOWN,milliseconds) : fallback;
}

function extractCanpar(number,data) {
    if(data?.error || !Array.isArray(data?.result) || data.result.length!==1 || data.result[0]?.barcode!==number) throw Error("TRACKING_ID_MISMATCH");
    const shipment=data.result[0];
    if(!Array.isArray(shipment.events) || shipment.events.length<1 || shipment.events.length>500) throw Error("NO_PHYSICAL_SCAN");
    const rows=shipment.events.map((event)=>{
        const match=/^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/.exec(event.local_date_time || "");
        if(!match) throw Error("LAYOUT_REVIEW_REQUIRED");
        const date=`${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
        let label="UNREVIEWED_CARRIER_SCAN";
        const deliveredScan=(event.code==="DEL" && event.code_description_en==="Our Package was Delivered" && event.web_description_en==="Your shipment is delivered on")
            || (event.code==="NSR" && event.code_description_en==="Your Package was Delivered with no Signature Required"
                && event.web_description_en==="Your shipment has been delivered - No Signature was required");
        if(deliveredScan) {
            if(event.local_date_time===shipment.events[0].local_date_time && shipment.delivered!==true) throw Error("SCAN_CONFLICT");
            label="Our Package was Delivered";
        } else if((event.code==="ARR" && event.code_description_en==="Package Has Arrived at Our Facility")
            || (event.code==="SRT" && event.code_description_en==="Sorting It Out-Stay Tuned!")
            || (event.code==="DPT" && event.code_description_en==="Departing sort facility")) label="In Transit";
        else if(event.code==="WC " && event.code_description_en==="Out for Delivery-Almost There!") label="Out for Delivery";
        else if(event.code==="TRF" && event.code_description_en==="Handed Off to a Local Delivery Partner"
            && event.web_description_en==="Your shipment is currently in transit and is expected on") label="In Transit";
        else if(((event.code==="HLD" && event.code_description_en==="Delayed at Facility")
            || (event.code==="INO" && event.code_description_en==="Handed Off to a Local Delivery Partner"))
            && event.web_description_en==="Your shipment is on hold, please connect with a live agent for further updates") label="Exception";
        return [date,label,""];
    });
    return {identities:[shipment.barcode],rows};
}

function extractSnapshot(carrier, number, html) {
    if(typeof html!=="string" || Buffer.byteLength(html)>MAX_HTML) throw Error("PAYLOAD_LIMIT");
    const $=cheerio.load(html);
    const cellText=(cell)=>{
        const copy=$(cell).clone();
        copy.find("br").replaceWith("\n");
        copy.find("span.text-sm").prepend("\n");
        return copy.text().split("\n").map((line)=>line.trim()).join("\n").trim();
    };
    const readRows=(table)=>$(table).find("tr").toArray().map((r)=>$(r).children("td,th").toArray().map(cellText));
    if(carrier==="GLS") {
        const tables=$("table").toArray();
        const scan=tables.filter((t)=>JSON.stringify(readRows(t)[0])===JSON.stringify(["Status","Location","Date","Time"]));
        const pieces=tables.filter((t)=>JSON.stringify(readRows(t)[0])===JSON.stringify(["#","Type","Quantity","Weight","Dimensions"]));
        const identity=$("span.font-bold.text-xl").toArray().map((n)=>$(n).text().trim()).filter((n)=>n===number);
        if(scan.length!==1 || pieces.length!==1 || $("#__NUXT_DATA__").length!==1) throw Error("LAYOUT_REVIEW_REQUIRED");
        return {identities:identity,rows:readRows(scan[0]),pieceCount:readRows(pieces[0]).length-1,nuxtPayload:$("#__NUXT_DATA__").text(),renderingTimezone:"UTC_SERVER_RENDERED"};
    }
    if(carrier==="ICS_COURIER") {
        const summary=$("table[id$='_gvresult']"),detail=$("table[id$='_gvTracingDetail']");
        if(summary.length!==1 || detail.length!==1) throw Error("LAYOUT_REVIEW_REQUIRED");
        const summaryRows=readRows(summary[0]);
        const headers=summaryRows[0];
        const currentRows=summaryRows.slice(1).filter((row)=>row.some(Boolean));
        const reviewedHeaders=["Tracking Number","Last Updated","Status","Signature","Est Delivery Date"];
        if(JSON.stringify(headers)!==JSON.stringify(reviewedHeaders) || currentRows.length!==1
            || currentRows[0].length!==reviewedHeaders.length) throw Error("LAYOUT_REVIEW_REQUIRED");
        return {identities:summary.find("tr").toArray().filter((r)=>$(r).children("td").length)
            .map((r)=>$(r).children("td").first().text().trim()),rows:readRows(detail[0]),
            currentScan:{local:currentRows[0][1],label:currentRows[0][2]}};
    }
    throw Error("BROWSER_REQUIRED");
}

function createPublicHttpTracking({fetchImpl=fetch,now=()=>new Date(),browserFallback=null}={}) {
    const cooldowns=new Map();
    async function poll(shipment,options={}) {
        const carrier=normalizeTrackingCarrier(shipment.carrier);
        try {
            const canonical=buildPublicTrackingUrl(carrier,shipment.trackingNumber);
            const clock=new Date(now()).getTime();
            if(!Number.isFinite(clock)) throw Error("INVALID_OBSERVATION_TIME");
            const cooldown=cooldowns.get(carrier);
            if(cooldown?.until>clock) return {ok:false,code:cooldown.code,retryAfterMs:cooldown.until-clock,httpStatus:cooldown.status};
            const url=carrier==="CANPAR" ? CANPAR_API : canonical;
            const signal=AbortSignal.timeout(20000);
            const response=await fetchImpl(url,{method:carrier==="CANPAR" ? "POST" : "GET",redirect:"error",signal,
                ...(carrier==="CANPAR" ? {body:JSON.stringify({barcode:shipment.trackingNumber})} : {}),
                headers:{"User-Agent":"WMS365/1.0 ShipmentTracking (+https://wms365.co)",
                    ...(carrier==="CANPAR" ? {Accept:"application/json","Content-Type":"application/json"} : {Accept:"text/html"})}});
            const contentType=response.headers.get("content-type") || "";
            if(response.status===429 || response.status===503) {
                const code=response.status===429 ? "CARRIER_RATE_LIMITED" : "CARRIER_UNAVAILABLE";
                const delay=retryAfterMs(response.headers.get("retry-after"),new Date(now()).getTime(),response.status===429 ? 15*60000 : 5*60000);
                cooldowns.set(carrier,{code,status:response.status,until:new Date(now()).getTime()+delay});
                await response.body?.cancel().catch(()=>{});
                return {ok:false,code,retryAfterMs:delay,httpStatus:response.status};
            }
            if(!response.ok || !(carrier==="CANPAR" ? /application\/json/i : /text\/html/i).test(contentType)) return {ok:false,code:"CARRIER_HTTP_FAILED"};
            if(Number(response.headers.get("content-length"))>MAX_HTML) {
                await response.body?.cancel().catch(()=>{});
                throw Error("PAYLOAD_LIMIT");
            }
            const chunks=[];let length=0;
            for await(const chunk of response.body){length+=chunk.length;if(length>MAX_HTML){await response.body.cancel().catch(()=>{});throw Error("PAYLOAD_LIMIT");}chunks.push(chunk);}
            const body=Buffer.concat(chunks).toString("utf8");
            const snapshot=carrier==="CANPAR" ? extractCanpar(shipment.trackingNumber,JSON.parse(body)) : extractSnapshot(carrier,shipment.trackingNumber,body);
            return await normalizePublicTracking(carrier,shipment.trackingNumber,snapshot,{...options,observedAt:new Date(now()).toISOString()});
        } catch(error) {
            if(browserFallback && (error.code || error.message)==="LAYOUT_REVIEW_REQUIRED") {
                try { return await browserFallback.poll(shipment,options); }
                catch { return {ok:false,code:"CARRIER_BROWSER_FAILED"}; }
            }
            return {ok:false,code:["LAYOUT_REVIEW_REQUIRED","PAYLOAD_LIMIT","TRACKING_ID_MISMATCH","TIMEZONE_REQUIRED","NO_PHYSICAL_SCAN","SCAN_CONFLICT","PIECE_REVIEW_REQUIRED","INVALID_SCAN_TIME","INVALID_OBSERVATION_TIME"].includes(error.code || error.message)
                ? error.code || error.message : "CARRIER_HTTP_READ_FAILED"};
        }
    }
    return {poll};
}
module.exports={extractSnapshot,extractCanpar,createPublicHttpTracking,retryAfterMs,MAX_HTML};

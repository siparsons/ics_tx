import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
process.env.TZ = "Europe/London";
const source = await readFile(new URL("../../src/CalendarBridge.Api/wwwroot/dakboard-assets/clashes.js", import.meta.url), "utf8");
const html = await readFile(new URL("../../src/CalendarBridge.Api/Dakboard/clashes.html", import.meta.url), "utf8");
const { createClashWidget, captureFreshness, overlapLabel, appointmentTime, dateLabel, splitClashes } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const now = new Date("2026-09-29T09:00:00Z");
function clash(id = "a", start = "2026-09-29T09:30:00Z", end = "2026-09-29T10:00:00Z") {
  return { id, overlapStart:start, overlapEnd:end, overlapMinutes:(Date.parse(end)-Date.parse(start))/60000,
    first:{calendarName:"ons",displayTitle:"ONS: Appointment X",start:new Date(Date.parse(start)-1800000).toISOString(),end},
    second:{calendarName:"ukhsa",displayTitle:"UKHSA: Appointment Y",start,end:new Date(Date.parse(end)+1800000).toISOString()} };
}
const future = (id="f") => clash(id,"2026-09-30T09:30:00Z","2026-09-30T10:00:00Z");
const calendars = [{name:"ons",lastCapturedAt:"2026-09-29T08:59:00Z"},{name:"ukhsa",lastCapturedAt:"2026-09-29T08:56:00Z"}];
function setup(initial = {clashes:[],calendars:[]}) {
  const {document} = parseHTML(html);
  let report=initial, fail=false, current=now, serial=0;
  const intervals=new Map(), timeouts=new Map(), calls=[];
  const widget=createClashWidget({document,location:{pathname:"/dakboard/clashes/test-widget-key/"},now:()=>current,
    fetch:async (url, options)=>{calls.push({url,options});if(fail)throw new Error("offline");return {ok:true,json:async()=>report};},
    setInterval:(fn,ms)=>{intervals.set(++serial,{fn,ms});return serial;},clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,ms)=>{timeouts.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timeouts.delete(id)});
  return {widget,document,intervals,timeouts,calls,node:id=>document.getElementById(id),
    tiles:()=>[...document.querySelectorAll(".clash-tile")],
    setReport:value=>{report=value;},setFail:value=>{fail=value;},setNow:value=>{current=value;}};
}
test("Zero clashes leaves the entire widget transparent and empty",async()=>{
  const h=setup();await h.widget.refresh();
  for(const id of ["clash-panel","future-panel","unavailable"]) assert.equal(h.node(id).hidden,true);
  assert.equal(h.tiles().length,0);
});
test("Today's tile uses safe display titles and full local 24-hour event times",async()=>{
  const item=clash();item.first.displayTitle='ONS: <img src=x onerror=alert(1)>';
  const h=setup({clashes:[item],calendars});await h.widget.refresh();const tile=h.tiles()[0];
  assert.equal(h.node("clash-panel").hidden,false);
  assert.match(h.node("clash-heading").textContent,/1 CLASH TODAY/);
  assert.equal(tile.querySelector(".event-title").textContent,item.first.displayTitle);
  assert.equal(tile.querySelector("img"),null);
  assert.equal(tile.querySelector(".overlap-time").textContent,"10:30\u201311:00");
  assert.deepEqual([...tile.querySelectorAll(".event-time")].map(n=>n.textContent),["10:00\u201311:00","10:30\u201311:30"]);
  assert.equal(tile.querySelector(".overlap-amount").textContent,"30 MIN OVERLAP");
  assert.equal(tile.querySelector(".freshness").textContent,"captured 4 mins ago");
  assert.equal(h.calls[0].url,"/dakboard/clashes/test-widget-key/data");
  assert.equal(h.calls[0].options.credentials,"omit");assert.equal(h.calls[0].options.headers,undefined);
});
test("All today's clashes stay visible in deterministic order while future clashes use the ticker",async()=>{
  const a=clash("a"),b=clash("b"),c=clash("c","2026-09-29T09:45:00Z");
  const h=setup({clashes:[future(),c,b,a],calendars});await h.widget.refresh();
  const original=h.tiles();assert.deepEqual(original.map(t=>t.dataset.clashId),["a","b","c"]);
  assert.match(h.node("clash-heading").textContent,/3 CLASHES TODAY/);
  const ticker=h.node("ticker-track").firstElementChild;
  assert.equal(ticker.children.length,1);assert.match(ticker.textContent,/Tomorrow/);
  for(let i=0;i<5;i++)h.widget.tick();
  assert.deepEqual(h.tiles(),original);assert.equal(h.node("ticker-track").firstElementChild,ticker);
  assert.equal(h.calls.length,1);
});
test("Refresh adds and removes today's pairs without replacing remaining tiles or restarting the ticker",async()=>{
  const a=clash("a"),b=clash("b"),f=future();
  const h=setup({clashes:[a,b,f],calendars});await h.widget.refresh();
  const remaining=h.tiles()[1],ticker=h.node("ticker-track").firstElementChild;
  h.setReport({clashes:[b,clash("c"),f],calendars});await h.widget.refresh();
  assert.equal(h.tiles()[0],remaining);assert.deepEqual(h.tiles().map(t=>t.dataset.clashId),["b","c"]);
  assert.equal(h.node("ticker-track").firstElementChild,ticker);
  h.setReport({clashes:[],calendars});await h.widget.refresh();assert.equal(h.tiles().length,0);
  assert.equal(h.node("clash-panel").hidden,true);assert.equal(h.node("future-panel").hidden,true);
});
test("Future-only mode has no red today tile and safely renders the scrolling text",async()=>{
  const f=future();f.first.displayTitle='<script>alert(1)</script>';
  const h=setup({clashes:[f],calendars});await h.widget.refresh();
  assert.equal(h.node("clash-panel").hidden,true);assert.equal(h.node("future-panel").hidden,false);
  assert.equal(h.node("future-heading").textContent,"COMING UP 1");
  assert.equal(h.node("ticker-track").querySelector("script"),null);
  assert.ok(h.node("ticker-track").textContent.includes(f.first.displayTitle));
  assert.equal(h.node("ticker-track").children[1].getAttribute("aria-hidden"),"true");
});
test("Clashes become active, then disappear at their exact end without a network request",async()=>{
  const h=setup({clashes:[clash()],calendars});await h.widget.refresh();
  assert.equal(h.tiles()[0].classList.contains("is-now"),false);
  h.setNow(new Date("2026-09-29T09:30:00Z"));h.widget.tick();
  assert.equal(h.tiles()[0].querySelector(".clash-state").textContent,"CLASH NOW");
  h.setNow(new Date("2026-09-29T10:00:00Z"));h.widget.tick();
  assert.equal(h.tiles().length,0);assert.equal(h.node("clash-panel").hidden,true);assert.equal(h.calls.length,1);
});
test("Local midnight promotes future clashes into persistent today tiles",async()=>{
  const h=setup({clashes:[future()],calendars});await h.widget.refresh();
  h.setNow(new Date("2026-09-29T23:00:00Z"));h.widget.tick();
  assert.equal(h.tiles().length,1);assert.equal(h.node("future-panel").hidden,true);
});
test("Day splitting includes ongoing overnight clashes and respects a 25-hour DST day",()=>{
  const overnight=clash("night","2026-09-28T22:00:00Z","2026-09-29T10:00:00Z");
  assert.equal(splitClashes([overnight],now).today.length,1);
  const beforeMidnight=clash("today","2026-10-25T23:30:00Z","2026-10-25T23:50:00Z");
  const atMidnight=clash("future","2026-10-26T00:00:00Z","2026-10-26T00:30:00Z");
  const result=splitClashes([beforeMidnight,atMidnight],new Date("2026-10-25T00:15:00+01:00"));
  assert.deepEqual(result.today.map(c=>c.id),["today"]);assert.deepEqual(result.future.map(c=>c.id),["future"]);
});
test("Failures retain last received alerts with an explicit warning; recovery can clear them",async()=>{
  const h=setup({clashes:[clash()],calendars});await h.widget.refresh();h.setFail(true);await h.widget.refresh();
  assert.equal(h.node("unavailable").hidden,false);assert.equal(h.node("cached-notice").hidden,false);
  assert.equal(h.tiles().length,1);
  h.setFail(false);h.setReport({error:"invalid"});await h.widget.refresh();assert.equal(h.node("unavailable").hidden,false);
  h.setReport({clashes:[],calendars:[]});await h.widget.refresh();assert.equal(h.node("unavailable").hidden,true);
  assert.equal(h.tiles().length,0);
});
test("Initial failure displays a warning without inventing clear or clash states",async()=>{
  const h=setup();h.setFail(true);await h.widget.refresh();
  assert.equal(h.node("unavailable").hidden,false);
  assert.equal(h.node("clash-panel").hidden,true);assert.equal(h.node("future-panel").hidden,true);
});
test("Freshness uses the oldest relevant capture and omits incomplete metadata",()=>{
  assert.deepEqual(captureFreshness(clash(),calendars,now),{label:"captured 4 mins ago",stale:false});
  assert.equal(captureFreshness(clash(),calendars.slice(0,1),now),null);
  assert.equal(captureFreshness(clash(),[{...calendars[0],lastCapturedAt:"invalid"},calendars[1]],now),null);
  assert.deepEqual(captureFreshness(clash(),calendars,new Date("2026-09-29T09:26:00Z")),{label:"captured 30 mins ago",stale:true});
});
test("Cross-midnight event tiles retain full date/time ranges",async()=>{
  const item=clash("night","2026-09-29T22:45:00Z","2026-09-29T23:15:00Z");
  item.first.start="2026-09-29T22:00:00Z";item.first.end="2026-09-30T00:00:00Z";
  assert.equal(overlapLabel(item,now),"Today \u00b7 23:45 \u2013 Tomorrow \u00b7 00:15");
  assert.equal(appointmentTime(item.first,item,now),"Today 23:00\n\u2013 Tomorrow 01:00");
  assert.equal(dateLabel(new Date("2026-09-29T23:00:00Z"),now),"Tomorrow");
  const h=setup({clashes:[item],calendars});await h.widget.refresh();
  assert.equal(h.tiles()[0].classList.contains("spans-dates"),true);
  assert.equal(h.tiles()[0].querySelector(".event-time").textContent,"Today 23:00\n\u2013 Tomorrow 01:00");
});
test("Polling and local clock updates start only once and are cleaned up",async()=>{
  const h=setup();h.widget.start();h.widget.start();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([...h.intervals.values()].map(x=>x.ms).sort((a,b)=>a-b),[15000,60000]);
  assert.equal(h.calls.length,1);assert.equal(h.timeouts.size,0);
  [...h.intervals.values()].find(x=>x.ms===60000).fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,2);
  h.widget.stop();assert.equal(h.intervals.size,0);await h.widget.refresh();assert.equal(h.calls.length,2);
});

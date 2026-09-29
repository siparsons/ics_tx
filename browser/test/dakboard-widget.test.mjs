import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
process.env.TZ = "Europe/London";
const source = await readFile(new URL("../../src/CalendarBridge.Api/wwwroot/dakboard-assets/clashes.js", import.meta.url), "utf8");
const html = await readFile(new URL("../../src/CalendarBridge.Api/Dakboard/clashes.html", import.meta.url), "utf8");
const { createClashWidget, captureFreshness, overlapLabel, appointmentTime, dateLabel } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const now = new Date("2026-09-29T09:00:00Z");
function clash(id = "a", start = "2026-09-29T09:30:00Z") {
  return { id, overlapStart:start, overlapEnd:"2026-09-29T10:00:00Z", overlapMinutes:30,
    first:{calendarName:"ons",displayTitle:"ONS: Appointment X",start:"2026-09-29T09:00:00Z",end:"2026-09-29T10:00:00Z"},
    second:{calendarName:"ukhsa",displayTitle:"UKHSA: Appointment Y",start:"2026-09-29T09:30:00Z",end:"2026-09-29T10:30:00Z"} };
}
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
    setReport:value=>{report=value;},setFail:value=>{fail=value;},setNow:value=>{current=value;}};
}
test("Zero clashes leaves both alert and warning hidden",async()=>{
  const h=setup();await h.widget.refresh();
  assert.equal(h.node("clash-panel").hidden,true);assert.equal(h.node("unavailable").hidden,true);
  assert.doesNotMatch(h.document.body.textContent,/No clashes|Everything is OK|0 clashes/);
});
test("Widget uses display titles as safe text, full event times, and local 24-hour overlap time",async()=>{
  const item=clash();item.first.displayTitle='ONS: <img src=x onerror=alert(1)>';
  const h=setup({clashes:[item],calendars});await h.widget.refresh();
  assert.equal(h.node("clash-panel").hidden,false);
  assert.equal(h.node("first-title").textContent,item.first.displayTitle);
  assert.equal(h.node("first-title").querySelector("img"),null);
  assert.equal(h.node("overlap-time").textContent,"Today · 10:30–11:00");
  assert.equal(h.node("first-time").textContent,"10:00–11:00");
  assert.equal(h.node("second-time").textContent,"10:30–11:30");
  assert.equal(h.node("overlap-amount").textContent,"30 MIN OVERLAP");
  assert.equal(h.node("clash-count").hidden,true);
  assert.equal(h.node("freshness").textContent,"captured 4 mins ago");
  assert.equal(h.calls[0].url,"/dakboard/clashes/test-widget-key/data");
  assert.equal(h.calls[0].options.credentials,"omit");assert.equal(h.calls[0].options.headers,undefined);
});
test("Multiple clashes sort and rotate without another fetch or page reload",async()=>{
  const a=clash("a"),b=clash("b"),c=clash("c","2026-09-29T09:45:00Z");
  b.first.displayTitle="ONS: Second";c.first.displayTitle="ONS: Third";
  const h=setup({clashes:[c,b,a],calendars});await h.widget.refresh();
  assert.equal(h.node("first-title").textContent,a.first.displayTitle);
  h.widget.rotate();assert.equal(h.node("first-title").textContent,b.first.displayTitle);
  assert.equal(h.node("clash-count").textContent,"2 of 3 clashes");
  h.widget.rotate();assert.equal(h.node("first-title").textContent,c.first.displayTitle);
  h.widget.rotate();assert.equal(h.node("clash-count").textContent,"1 of 3 clashes");
  assert.equal(h.calls.length,1);
});
test("Refresh retains the current pair by ID and resets safely when it disappears",async()=>{
  const a=clash("a"),b=clash("b");b.first.displayTitle="ONS: Second";
  const h=setup({clashes:[a,b],calendars});await h.widget.refresh();h.widget.rotate();
  h.setReport({clashes:[b,a],calendars});await h.widget.refresh();
  assert.equal(h.node("first-title").textContent,b.first.displayTitle);
  h.setReport({clashes:[a],calendars});await h.widget.refresh();
  assert.equal(h.node("first-title").textContent,a.first.displayTitle);
  h.setReport({clashes:[],calendars});await h.widget.refresh();assert.equal(h.node("clash-panel").hidden,true);
});
test("Failures and malformed data show a subdued warning, never a successful empty state",async()=>{
  const h=setup({clashes:[clash()],calendars});await h.widget.refresh();h.setFail(true);await h.widget.refresh();
  assert.equal(h.node("unavailable").hidden,false);assert.equal(h.node("clash-panel").hidden,true);
  assert.equal(h.node("unavailable").textContent,"⚠ Calendar clash data unavailable");
  h.setFail(false);h.setReport({error:"invalid"});await h.widget.refresh();assert.equal(h.node("unavailable").hidden,false);
  h.setReport({clashes:[],calendars:[]});await h.widget.refresh();assert.equal(h.node("unavailable").hidden,true);
});
test("Freshness uses the oldest of both relevant calendars and omits incomplete metadata",()=>{
  assert.deepEqual(captureFreshness(clash(),calendars,now),{label:"captured 4 mins ago",stale:false});
  assert.equal(captureFreshness(clash(),calendars.slice(0,1),now),null);
  assert.equal(captureFreshness(clash(),[{...calendars[0],lastCapturedAt:null},calendars[1]],now),null);
  assert.equal(captureFreshness(clash(),[{...calendars[0],lastCapturedAt:"invalid"},calendars[1]],now),null);
  assert.deepEqual(captureFreshness(clash(),calendars,new Date("2026-09-29T09:26:00Z")),{label:"captured 30 mins ago",stale:true});
  assert.deepEqual(captureFreshness(clash(),calendars,new Date("2026-09-29T09:56:00Z")),{label:"captured 1 hour ago",stale:true});
});
test("Cross-midnight events retain full date/time ranges and Tomorrow is local",()=>{
  const item=clash();item.overlapStart="2026-09-29T22:45:00Z";item.overlapEnd="2026-09-29T23:15:00Z";
  item.first.start="2026-09-29T22:00:00Z";item.first.end="2026-09-30T00:00:00Z";
  assert.equal(overlapLabel(item,now),"Today · 23:45 – Tomorrow · 00:15");
  assert.equal(appointmentTime(item.first,item,now),"Today 23:00\n– Tomorrow 01:00");
  assert.equal(dateLabel(new Date("2026-09-29T23:00:00Z"),now),"Tomorrow");
});
test("Ended clashes disappear between refreshes",async()=>{
  const h=setup({clashes:[clash()],calendars});await h.widget.refresh();
  h.setNow(new Date("2026-09-29T10:00:00Z"));h.widget.rotate();
  assert.equal(h.node("clash-panel").hidden,true);assert.equal(h.node("unavailable").hidden,true);
});
test("Polling and rotation start only once and are cleaned up",async()=>{
  const h=setup();h.widget.start();h.widget.start();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([...h.intervals.values()].map(x=>x.ms).sort((a,b)=>a-b),[11000,60000]);
  assert.equal(h.calls.length,1);assert.equal(h.timeouts.size,0);
  [...h.intervals.values()].find(x=>x.ms===60000).fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,2);
  h.widget.stop();assert.equal(h.intervals.size,0);await h.widget.refresh();assert.equal(h.calls.length,2);
});

import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {parseHTML} from "linkedom";
const source=await readFile(new URL("../../src/CalendarBridge.Api/wwwroot/dakboard-assets/absences.js",import.meta.url),"utf8");
const html=await readFile(new URL("../../src/CalendarBridge.Api/Dakboard/absences.html",import.meta.url),"utf8");
const {createAbsenceWidget,visiblePeople,returnLabel}=await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
const now=new Date("2026-10-12T09:00:00Z");
const person=(name,calendarName="ukhsa",start="2026-10-11T23:00:00Z",end="2026-10-12T23:00:00Z",allDay=true)=>({name,calendarName,expectedReturn:end,returnStatus:"expected",periods:[{start,end,allDay}]});
const report=(people=[])=>({generatedAt:now.toISOString(),timezone:"Europe/London",people,unnamedAbsenceCount:0,
  calendars:["ukhsa","ons"].map(name=>({name,lastCapturedAt:now.toISOString(),windowStart:"2026-10-11T23:00:00Z",windowEnd:"2026-10-18T23:00:00Z"}))});
function setup(data=report()){
 const {document}=parseHTML(html);let current=now,fail=false,result=data;const calls=[],intervals=new Map();let serial=0;
 const widget=createAbsenceWidget({document,location:{pathname:"/dakboard/absences/test/",search:"?calendar=ukhsa&timezone=Europe%2FLondon"},now:()=>current,
  fetch:async(url,options)=>{calls.push({url,options});if(fail)throw Error("offline");return {ok:true,json:async()=>result};},
  setInterval:(fn,ms)=>{intervals.set(++serial,{fn,ms});return serial;},clearInterval:id=>intervals.delete(id),setTimeout:()=>1,clearTimeout:()=>{}});
 return {widget,document,calls,intervals,node:id=>document.getElementById(id),setFail:v=>fail=v,setNow:v=>current=v,setReport:v=>result=v};
}
test("Combines all calendars with explicit safe labels and no calendar query restriction",async()=>{
 const h=setup(report([person("Alex","ons"),person("<img src=x onerror=alert(1)>")]));await h.widget.refresh();
 assert.equal(h.document.querySelectorAll(".person").length,2);
 assert.deepEqual([...h.document.querySelectorAll(".calendar")].map(n=>n.textContent),["ONS","UKHSA"]);
 assert.equal(h.document.querySelector("img"),null);
 assert.match(h.calls[0].url,/\/test\/data\?timezone=Europe%2FLondon$/);assert.doesNotMatch(h.calls[0].url,/calendar=/);
 assert.equal(h.calls[0].options.credentials,"omit");assert.equal(h.node("scope").textContent,"2 calendars");
});
test("A person spanning both days appears once and tomorrow-only absence has its own section",async()=>{
 const h=setup(report([person("Alex","ons",undefined,"2026-10-13T23:00:00Z"),person("Sam","ukhsa","2026-10-12T23:00:00Z","2026-10-13T23:00:00Z")]));await h.widget.refresh();
 assert.equal(h.node("today-list").children.length,1);assert.equal(h.node("tomorrow-list").children.length,1);
 assert.match(h.node("today-list").textContent,/Also away tomorrow/);assert.match(h.node("today-list").textContent,/back in 2 days/);
});
test("Timed absences end locally between polls and later absences are not described as out now",async()=>{
 const h=setup(report([person("Morning","ukhsa","2026-10-12T08:00:00Z","2026-10-12T11:00:00Z",false),person("Afternoon","ons","2026-10-12T13:00:00Z","2026-10-12T15:00:00Z",false)]));await h.widget.refresh();
 assert.match(h.node("today-list").textContent,/back today at 12:00/);assert.match(h.node("today-list").textContent,/Away from 14:00/);
 h.setNow(new Date("2026-10-12T12:00:00Z"));h.widget.render();assert.equal(h.node("today-list").children.length,1);
});
test("Failures keep last data clearly labelled and malformed updates cannot erase it",async()=>{
 const h=setup(report([person("Alex")]));await h.widget.refresh();h.setReport({people:[]});await h.widget.refresh();
 assert.equal(h.node("today-list").children.length,1);assert.match(h.node("notice").textContent,/last received/);
 h.setReport(report());await h.widget.refresh();assert.equal(h.node("notice").hidden,true);assert.equal(h.node("empty").hidden,false);
});
test("Unknown returns and missing coverage remain explicit",async()=>{
 const data=report([{...person("Alex"),expectedReturn:null,returnStatus:"insufficient-coverage"}]);data.calendars[0].windowEnd="2026-10-10T00:00:00Z";
 const h=setup(data);await h.widget.refresh();assert.match(h.node("today-list").textContent,/Return not yet known/);assert.match(h.node("freshness").textContent,/current view not captured/);
});
test("Midnight promotes tomorrow but warns if the report has not refreshed",async()=>{
 const h=setup(report([person("Tomorrow","ons","2026-10-12T23:00:00Z","2026-10-13T23:00:00Z")]));await h.widget.refresh();
 h.setNow(new Date("2026-10-13T00:00:00Z"));h.widget.render();assert.equal(h.node("today-list").children.length,1);assert.equal(h.node("tomorrow-panel").hidden,true);assert.match(h.node("notice").textContent,/may be incomplete/);
});
test("DST return countdown uses calendar days, and every refresh interval is stopped on disposal",()=>{
 const p=person("Alex","ons","2026-10-24T23:00:00Z","2026-10-26T00:00:00Z");
 assert.equal(returnLabel(p,"Europe/London",new Date("2026-10-24T11:00:00Z")),"Expected back in 2 days");
 const h=setup();h.widget.start();assert.deepEqual([...h.intervals.values()].map(x=>x.ms),[60000,15000]);h.widget.dispose();assert.equal(h.intervals.size,0);
});

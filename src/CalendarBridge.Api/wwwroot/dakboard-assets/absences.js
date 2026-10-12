const dateKey = (date, zone) => new Intl.DateTimeFormat("en-CA", {timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
const time = (date, zone) => new Intl.DateTimeFormat("en-GB", {timeZone:zone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date);
const daysBetween = (a,b) => Math.round((Date.parse(b+"T00:00:00Z")-Date.parse(a+"T00:00:00Z"))/86400000);
const nextDay = key => new Date(Date.parse(key+"T00:00:00Z")+86400000).toISOString().slice(0,10);
const date = value => {const result=new Date(value);if(typeof value!=="string"||!Number.isFinite(+result))throw Error("Invalid date");return result;};

export function visiblePeople(report, now) {
  const today=dateKey(now,report.timezone), tomorrow=nextDay(today);
  const todayPeople=[],tomorrowPeople=[];
  for(const person of report.people){
    const periods=person.periods.filter(p=>+date(p.end)>+now);
    const overlaps=(p,key)=>dateKey(date(p.start),report.timezone)<=key &&
      // Exclusive midnight end belongs to the previous date.
      dateKey(new Date(+date(p.end)-1),report.timezone)>=key;
    const onToday=periods.filter(p=>overlaps(p,today));
    const onTomorrow=periods.filter(p=>overlaps(p,tomorrow));
    if(onToday.length)todayPeople.push({...person,periods:onToday,alsoTomorrow:onTomorrow.length>0});
    else if(onTomorrow.length)tomorrowPeople.push({...person,periods:onTomorrow,alsoTomorrow:false});
  }
  const sort=(a,b)=>a.calendarName.localeCompare(b.calendarName)||a.name.localeCompare(b.name);
  return {today:todayPeople.sort(sort),tomorrow:tomorrowPeople.sort(sort)};
}
export function returnLabel(person, zone, now) {
  if(!person.expectedReturn || person.returnStatus!=="expected")return "Return not yet known";
  const end=date(person.expectedReturn), days=daysBetween(dateKey(now,zone),dateKey(end,zone));
  if(+end<=+now||days<0||days>7)return "Return not yet known";
  const timed=person.periods.some(p=>!p.allDay);
  if(days===0)return `Expected back today${timed?" at "+time(end,zone):""}`;
  return days===1?"Expected back tomorrow":`Expected back in ${days} days`;
}
function validate(value) {
  if(!value||!Array.isArray(value.people)||!Array.isArray(value.calendars)||!Number.isInteger(value.unnamedAbsenceCount)||value.unnamedAbsenceCount<0)throw Error("Invalid report");
  if(typeof value.timezone!=="string")throw Error("Invalid timezone");
  date(value.generatedAt);dateKey(new Date(),value.timezone);
  for(const p of value.people){
    if(typeof p.name!=="string"||typeof p.calendarName!=="string"||!Array.isArray(p.periods)||!p.periods.length)throw Error("Invalid person");
    for(const period of p.periods)if(!(date(period.end)>date(period.start))||typeof period.allDay!=="boolean")throw Error("Invalid period");
    if(p.expectedReturn!==null)date(p.expectedReturn);
  }
  for(const c of value.calendars)if(typeof c.name!=="string")throw Error("Invalid calendar");
  return value;
}
export function createAbsenceWidget({document:doc,location,fetch:fetchData=globalThis.fetch,now=()=>new Date(),
  setInterval:repeat=globalThis.setInterval,clearInterval:stopRepeat=globalThis.clearInterval,
  setTimeout:later=globalThis.setTimeout,clearTimeout:stopLater=globalThis.clearTimeout}={}) {
  const node=id=>doc.getElementById(id);
  const params=new URLSearchParams(location.search||""), query=new URLSearchParams();
  // Always combine all calendars, even if an old data URL's calendar parameter is pasted here.
  if(params.has("timezone"))query.set("timezone",params.get("timezone"));
  const endpoint=location.pathname.replace(/\/+$/,"")+"/data"+(query.size?"?"+query:"");
  let report=null,failed=false,busy=false,disposed=false,controller=null,intervals=[],signature="";
  function el(tag,className,text){const n=doc.createElement(tag);n.className=className;if(text!==undefined)n.textContent=text;return n;}
  function card(p,tomorrow,current){
    const n=el("article","person");n.setAttribute("role","listitem");
    const identity=el("div","identity");identity.append(el("h3","name",p.name));
    const badge=el("span","calendar",p.calendarName.toUpperCase());badge.dataset.calendar=p.calendarName;identity.append(badge);n.append(identity);
    const allDay=p.periods.some(period=>period.allDay);
    const active=p.periods.some(period=>+date(period.start)<=+current&&+date(period.end)>+current);
    const first=p.periods[0];
    const label=allDay?(tomorrow?"Away tomorrow":"Away today"):
      tomorrow?`Away ${time(date(first.start),report.timezone)}–${time(date(first.end),report.timezone)}`:
      active?"Out now":`Away from ${time(date(first.start),report.timezone)}`;
    n.append(el("p","state",label));n.append(el("p","return",returnLabel(p,report.timezone,current)));
    if(p.alsoTomorrow)n.append(el("p","also","Also away tomorrow"));
    return n;
  }
  function render(){
    if(disposed)return;
    const current=now();
    node("notice").hidden=!failed&&!!report;
    if(failed)node("notice").textContent=report?"Absence updates unavailable · showing last received data":"Absence data unavailable · retrying automatically";
    if(!report)return;
    const oldDay=dateKey(date(report.generatedAt),report.timezone)!==dateKey(current,report.timezone);
    if(oldDay){node("notice").hidden=false;node("notice").textContent="Waiting for today's absence update · last received data may be incomplete";}
    const split=visiblePeople(report,current);
    const next=JSON.stringify([split,[...split.today,...split.tomorrow].map(p=>[returnLabel(p,report.timezone,current),p.periods.some(period=>+date(period.start)<=+current&&+date(period.end)>+current)])]);
    if(next!==signature){
      for(const [key,list] of Object.entries(split)){
        node(key+"-panel").hidden=!list.length;node(key+"-count").textContent=String(list.length);
        node(key+"-list").replaceChildren(...list.map(p=>card(p,key==="tomorrow",current)));
      }
      signature=next;
    }
    node("empty").hidden=split.today.length+split.tomorrow.length>0||failed||oldDay;
    node("scope").textContent=`${report.calendars.length} calendar${report.calendars.length===1?"":"s"}`;
    node("unassigned").hidden=report.unnamedAbsenceCount===0;
    node("unassigned").textContent=`${report.unnamedAbsenceCount} additional absence ${report.unnamedAbsenceCount===1?"entry has":"entries have"} no identifiable name`;
    node("freshness").textContent=report.calendars.map(c=>{
      const captured=Date.parse(c.lastCapturedAt),minutes=Math.max(0,Math.floor((+current-captured)/60000));
      const age=!Number.isFinite(captured)?"capture unknown":minutes<1?"just updated":minutes<60?`captured ${minutes}m ago`:minutes<1440?`captured ${Math.floor(minutes/60)}h ago`:`captured ${Math.floor(minutes/1440)}d ago`;
      const covered=Date.parse(c.windowStart)<=+current && Date.parse(c.windowEnd)>+current;
      return `${c.name.toUpperCase()}: ${age}${covered?"":" · current view not captured"}`;
    }).join("   /   ");
  }
  async function refresh(){
    if(busy||disposed)return;busy=true;controller=new AbortController();
    const timeout=later(()=>controller?.abort(),12000);
    try{
      const response=await fetchData(endpoint,{cache:"no-store",credentials:"omit",signal:controller.signal});
      if(!response.ok)throw Error("Unavailable");
      const result=validate(await response.json());
      if(!disposed){report=result;failed=false;render();}
    }catch{if(!disposed){failed=true;render();}}
    finally{stopLater(timeout);controller=null;busy=false;}
  }
  function start(){if(intervals.length||disposed)return;void refresh();intervals=[repeat(()=>void refresh(),60000),repeat(render,15000)];}
  function dispose(){disposed=true;controller?.abort();intervals.forEach(stopRepeat);intervals=[];}
  return {start,refresh,render,dispose};
}
if(typeof document!=="undefined"&&typeof location!=="undefined")createAbsenceWidget({document,location}).start();

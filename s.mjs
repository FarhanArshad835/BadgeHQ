import WS from "ws";
const r=await (await fetch("http://127.0.0.1:9333/json/new?about:blank",{method:"PUT"})).json();
const ws=new WS(r.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
let id=0;const waits=new Map();
const send=(m,p={})=>new Promise(res=>{const i=++id;waits.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(res=>ws.on("open",res));
ws.on("message",d=>{const m=JSON.parse(d);if(m.id&&waits.has(m.id)){waits.get(m.id)(m.result);waits.delete(m.id);}});
await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
await send("Network.setCacheDisabled",{cacheDisabled:true});
await send("Emulation.setDeviceMetricsOverride",{width:1300,height:900,deviceScaleFactor:1,mobile:false});
const ev=async e=>{const x=await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});return x?.result?.value;};
await send("Page.navigate",{url:"https://jmlooks.com/collections/womens-heels-and-flats-2-for-1299"});
await new Promise(r=>setTimeout(r,19000));
console.log("page 1:", await ev('document.querySelectorAll("#product-grid li.grid__item").length'),
            "cards,", await ev('document.querySelectorAll("[data-bhq-color]").length'), "tagged");
for(let i=0;i<8;i++){ await ev('window.scrollTo(0,document.body.scrollHeight);1'); await new Promise(r=>setTimeout(r,3800)); }
const tot=await ev('document.querySelectorAll("#product-grid li.grid__item").length');
const tag=await ev('document.querySelectorAll("[data-bhq-color]").length');
console.log("after scrolling:", tot, "cards,", tag, "tagged,", tot-tag, "UNTAGGED");
// every tagged card: does its title end with its own colour?
const bad=await ev(`(function(){var o=[];var ls=document.querySelectorAll("#product-grid li.grid__item");
 for(var i=0;i<ls.length;i++){
  var c=ls[i].getAttribute("data-bhq-color"); if(!c) continue;
  var h3=ls[i].querySelector(".card__heading a,h3 a"); var t=h3?h3.textContent.trim():"";
  var want=" - "+c;
  if(t.slice(-want.length)!==want) o.push({c:c,t:t.slice(-40)});
 } return o;})()`);
console.log("tagged cards whose title does NOT end in their colour:", (bad||[]).length);
(bad||[]).slice(0,6).forEach(x=>console.log("   colour="+x.c+"  title ends: "+x.t));
// any card still showing a theme-made colour title without being split?
const untag=await ev(`(function(){var o=[];var ls=document.querySelectorAll("#product-grid li.grid__item");
 for(var i=0;i<ls.length;i++){
  if(ls[i].getAttribute("data-bhq-color")) continue;
  var h3=ls[i].querySelector(".card__heading a,h3 a"); var t=h3?h3.textContent.trim():"";
  if(/ - [A-Za-z-]+$/.test(t)) o.push(t.slice(-42));
 } return o;})()`);
console.log("\nUNSPLIT cards still showing a colour in the title:", (untag||[]).length);
(untag||[]).slice(0,6).forEach(x=>console.log("   "+x));
ws.close(); process.exit(0);

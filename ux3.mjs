import WS from "ws";
const r=await (await fetch("http://127.0.0.1:9333/json/new?about:blank",{method:"PUT"})).json();
const ws=new WS(r.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
let id=0;const waits=new Map();
const send=(m,p={})=>new Promise(res=>{const i=++id;waits.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(res=>ws.on("open",res));
ws.on("message",d=>{const m=JSON.parse(d);if(m.id&&waits.has(m.id)){waits.get(m.id)(m.result);waits.delete(m.id);}});
await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
await send("Network.setCacheDisabled",{cacheDisabled:true});
await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
await send("Emulation.setCPUThrottlingRate",{rate:4});
await send("Network.emulateNetworkConditions",{offline:false,latency:150,downloadThroughput:1.6*1024*1024/8,uploadThroughput:750*1024/8});
const ours=[];
ws.on("message",d=>{const m=JSON.parse(d);
 if(m.method==="Network.requestWillBeSent"){const u=m.params.request.url;
  if(/badgehq|section_id=|color-demand|api\/order|api\/widgets|products\.json/.test(u)) ours.push(u.replace(/^https?:\/\/[^/]+/,""));}});
const ev=async e=>{const x=await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});return x?.result?.value;};
// watch the first card's position to detect visible movement
await send("Page.navigate",{url:"https://jmlooks.com/collections/womens-heels-and-flats-2-for-1299"});
await new Promise(r=>setTimeout(r,2500));
const samples=[];
for(let i=0;i<14;i++){
  const h=await ev(`(function(){var a=document.querySelector("#product-grid li.grid__item a[href*='/products/']");
   return a? ((a.getAttribute("href")||"").split("/products/")[1]||"").split("?")[0].slice(0,26) : "(none)";})()`);
  samples.push((2500+i*1500)+"ms "+h);
  await new Promise(r=>setTimeout(r,1500));
}
console.log("WHAT IS CARD #1 OVER TIME (does the grid visibly change under them?)");
let prev=null, changes=0;
samples.forEach(s=>{const h=s.split(" ")[1]; if(prev&&h!==prev)changes++; prev=h; console.log("   "+s);});
console.log("   -> card #1 changed "+changes+" times after first paint");
console.log("\nOUR OWN REQUESTS ("+ours.length+"):");
const c={}; ours.forEach(u=>{const k=u.split("?")[0]; c[k]=(c[k]||0)+1;});
Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log("   "+String(v).padStart(3)+"  "+k.slice(0,60)));
ws.close(); process.exit(0);

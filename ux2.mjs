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
const by={};
ws.on("message",d=>{const m=JSON.parse(d);
 if(m.method==="Network.responseReceived"){const u=m.params.response.url;
  let k="other";
  if(/\.(jpg|jpeg|png|webp|avif)/i.test(u)) k="images";
  else if(/\.js/i.test(u)) k="scripts";
  else if(/\.css/i.test(u)) k="css";
  else if(/products\.json|api\//i.test(u)) k="api/json";
  by[k]=(by[k]||0)+1;}});
const ev=async e=>{const x=await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});return x?.result?.value;};
await send("Page.navigate",{url:"https://jmlooks.com/collections/womens-heels-and-flats-2-for-1299"});
await new Promise(r=>setTimeout(r,22000));
console.log("requests by type:", JSON.stringify(by));
console.log("");
// third-party scripts
console.log("third-party scripts loaded:");
console.log(await ev(`(function(){var h={};var ss=document.querySelectorAll("script[src]");
 for(var i=0;i<ss.length;i++){try{var d=new URL(ss[i].src).hostname; if(!/jmlooks\.com/.test(d)) h[d]=(h[d]||0)+1;}catch(e){}}
 return Object.entries(h).sort(function(a,b){return b[1]-a[1];}).slice(0,10).map(function(x){return x[1]+"  "+x[0];}).join("\u0001");})()`));
console.log("");
// scroll responsiveness
const t0=Date.now();
await ev('window.scrollTo(0,document.body.scrollHeight);1');
await new Promise(r=>setTimeout(r,6000));
const n2=await ev('document.querySelectorAll("#product-grid li.grid__item").length');
console.log("after 1 scroll, "+(Date.now()-t0)+"ms: "+n2+" cards");
ws.close(); process.exit(0);

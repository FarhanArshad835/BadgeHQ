import WS from "ws";
const r=await (await fetch("http://127.0.0.1:9333/json/new?about:blank",{method:"PUT"})).json();
const ws=new WS(r.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
let id=0;const waits=new Map();
const send=(m,p={})=>new Promise(res=>{const i=++id;waits.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(res=>ws.on("open",res));
ws.on("message",d=>{const m=JSON.parse(d);if(m.id&&waits.has(m.id)){waits.get(m.id)(m.result);waits.delete(m.id);}});
await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
await send("Network.setCacheDisabled",{cacheDisabled:true});
// mid-range Android on 4G
await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
await send("Emulation.setCPUThrottlingRate",{rate:4});
await send("Network.emulateNetworkConditions",{offline:false,latency:150,downloadThroughput:1.6*1024*1024/8,uploadThroughput:750*1024/8});
const reqs=[]; let bytes=0;
ws.on("message",d=>{const m=JSON.parse(d);
 if(m.method==="Network.requestWillBeSent") reqs.push(m.params.request.url);
 if(m.method==="Network.loadingFinished") bytes+=m.params.encodedDataLength||0;});
const ev=async e=>{const x=await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});return x?.result?.value;};
const t0=Date.now();
await send("Page.navigate",{url:"https://jmlooks.com/collections/womens-heels-and-flats-2-for-1299"});
await new Promise(r=>setTimeout(r,22000));
console.log("=== MOBILE, 4x CPU throttle, 4G ===");
console.log("requests on first load:", reqs.length, " bytes:", (bytes/1024/1024).toFixed(1)+"MB");
console.log("cards:", await ev('document.querySelectorAll("#product-grid li.grid__item").length'));
console.log("");
const t=await ev(`JSON.stringify((function(){var n=performance.getEntriesByType("navigation")[0]||{};
 var p=performance.getEntriesByType("paint");
 return {dom:Math.round(n.domContentLoadedEventEnd||0), load:Math.round(n.loadEventEnd||0),
  fcp:Math.round((p.find(function(x){return x.name==="first-contentful-paint";})||{}).startTime||0)};})())`);
console.log("timings:", t);
// long tasks
console.log("long tasks >50ms:", await ev(`(function(){try{return performance.getEntriesByType("longtask").length}catch(e){return "n/a"}})()`));
ws.close(); process.exit(0);

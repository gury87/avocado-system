import {test} from "node:test";
import assert from "node:assert/strict";
import {weightBreakdown,lossReport,groupLoss,yieldByPlot,shipmentDateGap} from "../app/lib/analysis.ts";
import {isOverdue} from "../app/lib/catalog.ts";
test("Overdue marking uses a strict day threshold and only outstanding containers",()=>{
  assert.equal(isOverdue("2026-10-01",5,0,14,"2026-10-15"),false);
  assert.equal(isOverdue("2026-09-30",5,2,14,"2026-10-15"),true);
  assert.equal(isOverdue("2026-09-30",5,5,14,"2026-10-15"),false);
  assert.equal(isOverdue("2026-09-30",5,2,30,"2026-10-15"),false);
  assert.equal(isOverdue("2026-10-20",5,0,0,"2026-10-15"),false);
});
test("Loss excludes container tare, distinguishes missing and impossible inputs, and weights aggregate percentages",()=>{
  const line={gross_weight:"657",containers:"2",tare_weight:"40",net_weight:"560"};
  const w=weightBreakdown(line);assert.equal(w.tare,80);assert.equal(w.loss,17);assert.equal(w.fruitGross,577);assert.ok(Math.abs(w.percent-17/577*100)<1e-9);
  assert.equal(weightBreakdown({...line,net_weight:""}),null);
  assert.equal(weightBreakdown({...line,gross_weight:"600"}).invalid,true);
  const data={receipts:[{id:"r",trader_id:"1",status:"confirmed",lines:[{...line,id:"l",variety_id:"2",trader_date:"2026-09-10",allocations:[{harvest_event_id:"1",containers:"1",net_weight:"200"},{harvest_event_id:"2",containers:"1",net_weight:"360"}]}]},{id:"draft",status:"draft",lines:[]}]};
  const a=lossReport(data,[{shipment:{id:"1"}}]),b=lossReport(data,[{shipment:{id:"2"}}]);
  assert.equal(a[0].loss,8.5);assert.equal(a[0].net,200);assert.equal(a[0].tare,40);
  assert.equal(a[0].gross+b[0].gross,657);
  const [g]=groupLoss([...a,...b]);assert.equal(g.loss,17);assert.equal(g.net,560);assert.ok(Math.abs(g.percent-17/577*100)<1e-9);
});
test("Plot yield uses stored dunam once per plot, preserves partial coverage and handles missing/zero areas",()=>{
  const row=(id,plot,containers,paid,kg,revenue)=>({shipment:{id,plot_id:plot,containers},paid,kg,revenue});
  const values=yieldByPlot([row("a","1",4,2,560,100800),row("b","1",6,6,1200,400000),row("c","2",3,0,0,0),row("d","3",2,0,0,0)], [{id:"1",name:"א",dunam:10},{id:"2",name:"ב",dunam:null},{id:"3",name:"ג",dunam:0}]);
  assert.equal(values[0].containersPerDunam,1);assert.equal(values[0].netPerDunam,176);assert.equal(values[0].revenuePerDunam,50080);assert.equal(values[0].partial,true);
  assert.equal(values[1].containersPerDunam,null);assert.equal(values[2].netPerDunam,null);
});
test("Loss lines preserve each selected shipment date and signed calendar-day gap",()=>{
  assert.equal(shipmentDateGap("2026-10-25","2026-10-26"),1);
  assert.equal(shipmentDateGap("2026-10-27","2026-10-26"),-1);
  assert.equal(shipmentDateGap("2026-10-26","2026-10-26"),0);
  assert.equal(shipmentDateGap("","2026-10-26"),null);
  assert.equal(shipmentDateGap("2026-10-25",""),null);
  const data={receipts:[{id:"r",trader_id:"1",status:"confirmed",lines:[{id:"l",variety_id:"2",trader_date:"2026-10-26",gross_weight:"657",containers:"2",tare_weight:"40",net_weight:"560",allocations:[{harvest_event_id:"1",containers:"1",net_weight:"200"},{harvest_event_id:"2",containers:"1",net_weight:"360"}]}]}]};
  const rows=[{shipment:{id:"1",harvest_date:"2026-10-25"}},{shipment:{id:"2",harvest_date:"2026-10-27"}}];
  assert.deepEqual(lossReport(data,rows)[0].shipments,[{id:"1",date:"2026-10-25",days:1},{id:"2",date:"2026-10-27",days:-1}]);
  assert.equal(lossReport(data,[rows[1]])[0].shipments.length,1,"Dates respect the report filters");
});

import type { ReceiptLine } from "./receipts";
import type { CatalogEntry } from "./catalog";
import type { ReportData, ReportRow } from "./reports";
export function weightBreakdown(line: Pick<ReceiptLine,"gross_weight"|"containers"|"tare_weight"|"net_weight">) {
  const values=[line.gross_weight,line.containers,line.tare_weight,line.net_weight];
  if(values.some((v)=>v===""||v==null||!Number.isFinite(Number(v))))return null;
  const gross=Number(line.gross_weight),containers=Number(line.containers),net=Number(line.net_weight),tare=containers*Number(line.tare_weight);
  if(gross<=0||containers<=0||tare<0||net<0)return null;
  const fruitGross=gross-tare, loss=fruitGross-net;
  return {gross,tare,net,fruitGross,loss,percent:fruitGross>0?loss/fruitGross*100:null,invalid:loss < -0.0005||fruitGross<=0};
}
export function shipmentDateGap(shipmentDate:string,traderDate:string):number|null{
  if(!shipmentDate||!traderDate)return null;
  const days=(Date.parse(traderDate+"T00:00:00Z")-Date.parse(shipmentDate+"T00:00:00Z"))/86400000;
  return Number.isFinite(days)?Math.round(days):null;
}
export type LossRow={id:string;receiptId:string;trader:string;variety:string;date:string;shipments:{id:string;date:string;days:number|null}[];gross:number;tare:number;net:number;loss:number;fruitGross:number;percent:number|null};
export function lossReport(data:ReportData,rows:ReportRow[]):LossRow[]{
  const selected=new Set(rows.map((r)=>r.shipment.id));
  const shipments=new Map(rows.map((r)=>[r.shipment.id,r.shipment]));
  return data.receipts.filter((r)=>r.status==="confirmed").flatMap((receipt)=>receipt.lines.flatMap((line)=>{
    const base=weightBreakdown(line); if(!base)return [];
    const allocations=line.allocations.filter((a)=>selected.has(a.harvest_event_id));if(!allocations.length)return [];
    const containers=allocations.reduce((s,a)=>s+Number(a.containers),0),net=allocations.reduce((s,a)=>s+Number(a.net_weight),0);
    const share=containers/Number(line.containers),tare=containers*Number(line.tare_weight),loss=base.loss*share,fruitGross=net+loss;
    return [{id:receipt.id+":"+line.id,receiptId:receipt.id,trader:receipt.trader_id,variety:line.variety_id,date:line.trader_date,
      shipments:allocations.map((a)=>{const date=shipments.get(a.harvest_event_id)?.harvest_date||"";return{id:a.harvest_event_id,date,days:shipmentDateGap(date,line.trader_date)};}),
      gross:fruitGross+tare,tare,net,loss,fruitGross,percent:fruitGross>0?loss/fruitGross*100:null}];
  }));
}
export function groupLoss(rows:LossRow[]){
  const groups=new Map<string,{key:string;gross:number;tare:number;net:number;loss:number;fruitGross:number;lines:number}>();
  for(const row of rows){const key=JSON.stringify([row.trader,row.variety]);const g=groups.get(key)||{key,gross:0,tare:0,net:0,loss:0,fruitGross:0,lines:0};g.gross+=row.gross;g.tare+=row.tare;g.net+=row.net;g.loss+=row.loss;g.fruitGross+=row.fruitGross;g.lines++;groups.set(key,g);}
  return [...groups.values()].map((g)=>({...g,percent:g.fruitGross>0?g.loss/g.fruitGross*100:null}));
}
export function yieldByPlot(rows:ReportRow[],plots:CatalogEntry[]){
  const groups=new Map<string,{id:string;containers:number;paid:number;net:number;revenue:number}>();
  for(const row of rows){const id=row.shipment.plot_id,g=groups.get(id)||{id,containers:0,paid:0,net:0,revenue:0};g.containers+=Number(row.shipment.containers);g.paid+=row.paid;g.net+=row.kg;g.revenue+=row.revenue;groups.set(id,g);}
  return [...groups.values()].map((g)=>{const plot=plots.find((p)=>p.id===g.id),area=plot?.dunam&&plot.dunam>0?plot.dunam:null;return {...g,name:plot?.name||"חלקה לא ידועה",area,containersPerDunam:area?g.containers/area:null,netPerDunam:area?g.net/area:null,revenuePerDunam:area?g.revenue/area:null,partial:g.paid+0.0005<g.containers};});
}

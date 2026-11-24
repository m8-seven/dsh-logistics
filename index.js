
import {freightTools} from './lib/freight-tools.js';
import { homedir } from 'node:os';
import path from 'node:path';

import { Store,visibleError } from './lib/store.js';

import { newProfile,need,InputError } from './lib/config.js';
import { identify } from './lib/routing.js';
import { remoteRecords } from './lib/connections.js';
export const name='freight-reconciliation';
export const inject=['connection','llm','tools'];
const MiB=1024*1024;
async function collect(req,max) {
  need(Number(req.headers.get('content-length')||0)<=max,'请求超过大小限制',413);
  need(req.body,'请求缺少内容');
  const reader=req.body.getReader(),parts=[];
  let size=0;
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      need(size<=max,'请求超过大小限制',413);
      parts.push(value);
    }
  } catch(e) {
    await reader.cancel().catch(()=>{
    });
    throw e;
  }
  finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
async function readObject(req) {
  const bytes=await collect(req,150000);
  try {
    const d=JSON.parse(bytes.toString('utf8'));
    need(d&&typeof d==='object'&&!Array.isArray(d),'无效参数');
    return d;
  }
  catch {
    throw new InputError('请求 JSON 无效');
  }
}

export function nativeRoutes(store,ctx,workbooks){
  const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
  const routes=[];
  function add(name,method,run,body){
    routes.push({path:'/api/freight/'+name,methods:[method],requestBody:body??'buffered',
    async fetch(req){
      try {
        if(method==='POST')need(req.headers.get('x-freight-client')==='panel','请使用插件页面',403);
        const data=body==='buffered'?await readObject(req):null;
        const result=await run(data,new URL(req.url).searchParams,req);
        return result instanceof Response?result:json(result);
      } catch(e){
        return json({error:visibleError(e)},e instanceof InputError?e.status:500);
      }
    }
    });
  }
  add('stage','POST',async(_,q,req)=>{
    workbooks.stage(q.get('session')||'',q.get('file')||'',await collect(req,256*MiB));return {ok:true};
  },'streaming');
  add('state','GET',()=>({channels:store.channels(),template:newProfile(),jobs:store.jobs(),publicUrls:store.publicUrls()}));
  add('apis','GET',(_,q)=>store.apis(q.get('code')||''));
  add('jobs','GET',(_,q)=>store.jobs(q.get('id')||undefined));
  add('inspect','POST',d=>identify(store.channels(),d.names),'buffered');
  add('channel-save','POST',d=>store.saveChannel(d,d.rev===undefined?undefined:d.code),'buffered');
  add('api-save','POST',d=>store.saveApi(d,d.id),'buffered');
  add('public-url','POST',d=>store.saveUrl(d),'buffered');
  add('models','GET',async()=> (await Promise.all(ctx.llm.listProviders().map(async p=>{
    try{return (await ctx.llm.listModels(p.id)).map(m=>({provider:p.id,id:m.id}))}catch{return []}
  }))).flat());
  add('channel-remove','POST',d=>{
    store.remove('channel',d.id,d.rev);return {ok:true};
  },'buffered');
  add('api-remove','POST',d=>{
    store.remove('api',d.id,d.rev);return {ok:true};
  },'buffered');
  add('test-api','POST',async({code,id,period,waybill})=>{
    const a=store.apis(code,true).find(v=>v.id===id);
    need(a,'请先保存接口',404);need(/^\d{4}(0[1-9]|1[0-2])$/.test(period),'账期格式为 YYYYMM');
    need(a.mode!=='order'||(typeof waybill==='string'&&waybill.trim()),'请填写测试运单号');
    const r=await remoteRecords(a,code,period,waybill||'');
    return {count:r.count,matched:waybill?r.items.has(waybill)&&r.items.get(waybill)!==null:null};
  },'buffered');
  add('download','GET',(_,q)=>{
    const d=store.download(q.get('id')||'');
    return new Response(d.result,{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','cache-control':'no-store','content-disposition':'attachment; filename="result.xlsx"; filename*=UTF-8'+String.fromCharCode(39,39)+encodeURIComponent(d.filename).replace(/'/g,'%27')}});
  });
  return routes;
}

export function apply(ctx){
  const store=new Store(path.resolve(process.env.FREIGHT_HOME||path.join(homedir(),'.dsh-freight')));
  store.recover();
  const workbooks=freightTools(store);
  ctx.tools.register({
    name:'freight_workbook',description:'物流核对专用工具。action=list/sheets/read/lookup/next/record/export。file 使用 list 返回的路径，sheet 使用原表名。read 传 start,count。lookup 传 ids 数组。先用 next 获取最多 12 个原行号，只记录这一批；两步均通过的行仅传 passed:[行号]，异常行传 rows 数组，每项 {row, api, quote, yellow, local, price, reason, source}，api 和 quote 取 一致/差异/待复核；yellow 是要标黄的原表列字母数组；local、price 为数值或 null。source 写报价文件、工作表/单元格或图片分栏。每行恰好提交一次。工具返回下一批行号；末批自动生成下载项。',
    parameters:{type:'object',required:['action'],properties:{action:{type:'string',enum:['list','sheets','read','lookup','next','record','export']},file:{type:'string'},sheet:{type:'string'},start:{type:'integer'},count:{type:'integer'},ids:{type:'array',items:{type:'string'}},passed:{type:'array',maxItems:12,uniqueItems:true,items:{type:'integer'}},rows:{type:'array',maxItems:12,items:{type:'object',properties:{row:{type:'integer'},api:{type:'string'},quote:{type:'string'},yellow:{type:'array',items:{type:'string'}},local:{type:['number','null']},price:{type:['number','null']},reason:{type:'string'},source:{type:'string'}},required:['row','api','quote','yellow']}}}},
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},
    timeoutMs:900000,execute:async(args,exec)=>JSON.stringify(await workbooks.run(exec.agent?.session?.id,args,exec.signal))
  });

  ctx.effect(()=>()=>{
    store.close();
  });
  for(const route of nativeRoutes(store,ctx,workbooks)) ctx.effect(()=>ctx.connection.fetch.register(route),'freight: '+route.path);
}

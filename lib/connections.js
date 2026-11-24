import {need,InputError,httpURL} from './config.js';
import {ruleGuide,buildMatcher,num} from './rules.js';
import {tableColumn} from './workbook.js';
async function request(url,options,label,limit=8*1024*1024,timeout=20000){
  httpURL(url);
  const signal=AbortSignal.timeout(timeout);
  let r;
  try{
    r=await fetch(url,{...options,signal,redirect:'error'});
  }catch{
    throw new InputError(label+(signal.aborted?'请求超时':'无法连接，请检查地址与证书'));
  }
  if(!r.ok){
    await r.body?.cancel();
    throw new InputError(label+' 返回 HTTP '+r.status);
  }
  const parts=[];
  let size=0;
  const reader=r.body?.getReader();
  need(reader,label+'响应为空');
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      need(size<=limit,label+'返回内容过大，请缩小范围或分页');
      parts.push(value);
    }
  }
  catch(e){
    await reader.cancel().catch(()=>{
    });
    if(e instanceof InputError)throw e;
    throw new InputError(label+'响应中断');
  }
  finally{
    reader.releaseLock();
  }
  try{
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }catch{
    throw new InputError(label+'未返回有效 JSON');
  }
}

export async function compile(model,p,period,bill,quotes){
  function sample(t){
    return {id:t.id,file:t.file,sheet:t.sheet,columns:t.columns,sample:t.rows.slice(0,3).map(r=>({row:r.n,cells:Object.fromEntries(Object.entries(r.cells).map(([k,v])=>[k,String(v??'').slice(0,150)]))}))};
  }
  const info=JSON.stringify({channel:p.code,period,prompt:p.prompt,bill:sample(bill),quotes:quotes.map(sample)});
  need(info.length<=100000,'表头和样本超过模型输入范围，请调整工作表范围');
  const msgs=[{role:'system',content:ruleGuide},{role:'user',content:info}],headers={'content-type':'application/json'};
  if(model.token)headers.Authorization='Bearer '+model.token;
  for(let i=0;i<2;i++){
    need(model.generate,'请在上传前选择 Harness 模型以解析自定义提示词');
    const reply=await model.generate(msgs);
    try{
      const plan=JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
      return {plan,match:buildMatcher(plan,bill,quotes,p.code,period)};
    }
    catch(e){
      if(i)throw new InputError('模型规则无法执行：'+(e instanceof InputError?e.message:'无效的 JSON 规则'));
      msgs.push({role:'user',content:'返回完整的合法规则 JSON。'+(e instanceof InputError?e.message:'上次结果不是 JSON')+'。无法表达时请返回 unsupported。'});
    }
  }
}
function valueAt(o,k){
  for(const p of k?k.split('.'):[]){
    if(!o||typeof o!=='object'||!Object.hasOwn(o,p))return undefined;
    o=o[p];
  }return o;
}
function substitute(s,vars,url=false){
  return s.replace(/\{(code|period|waybill|page)\}/g,(_,k)=>url?encodeURIComponent(vars[k]):String(vars[k]));
}
function substituteBody(v,vars){
  if(typeof v==='string')return v==='{page}'?vars.page:substitute(v,vars);
  if(Array.isArray(v))return v.map(x=>substituteBody(x,vars));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,val])=>[k,substituteBody(val,vars)]));
  return v;
}

export async function remoteRecords(api,code,period,waybill){
  const paged=(api.url+(api.body||'')).includes('{page}'),items=new Map();
  let count=0;
  for(let page=1;page<=(paged?api.maxPages:1);page++){
    const vars={code,period,waybill,page},headers={};
    if(api.token)headers[api.authHeader]=api.token;
    const options={method:api.method,headers};
    if(api.method==='POST'&&api.body){
      headers['Content-Type']='application/json';
      options.body=JSON.stringify(substituteBody(JSON.parse(api.body),vars));
    }
    const doc=await request(substitute(api.url,vars,true),options,'接口「'+api.name+'」');
    if(api.successPath)need(String(valueAt(doc,api.successPath))===String(api.successValue),'接口业务状态未成功');
    let list=valueAt(doc,api.arrayPath);
    if(api.mode==='order'&&list===null)list=[];
    if(api.mode==='order'&&list&&typeof list==='object'&&!Array.isArray(list))list=[list];
    need(Array.isArray(list),'接口记录路径没有返回数组');
    if(!list.length)break;
    for(const entry of list){
      count++;
      need(count<=150000,'接口记录超过 15 万条');
      const id=valueAt(entry,api.keyPath);
      if(id===null||id===undefined||String(id).trim()==='')continue;
      const key=String(id).trim();
      items.set(key,items.has(key)?null:entry);
    }
    if(!paged)break;
    need(page<api.maxPages,'已到最大分页数仍有数据，请调大分页上限');
  }return {count,items};
}

export function checker(api,bill,code,period){
  const cached=new Map();
  return async(row,waybill,quote)=>{
    try{
      need(waybill,'账单运单号缺失或精度不足');
      const key=api.mode==='batch'?'':waybill;
      if(!cached.has(key))cached.set(key,remoteRecords(api,code,period,key));
      const {items}=await cached.get(key);
      need(items.has(waybill),'接口缺少该运单');
      const entry=items.get(waybill);
      need(entry,'接口返回多条同号记录');
      return api.checks.map(c=>{
        const base={api:api.name,bill:c.bill,remote:c.remote,tolerance:c.tolerance};
        try{
          const a=c.bill==='@账单值'?quote.local:c.bill==='@报价值'?quote.remote:row.cells[tableColumn(bill,c.bill)],z=valueAt(entry,c.remote);
          need(a!==null&&a!==undefined&&a!==''&&z!==null&&z!==undefined&&z!==''&&typeof z!=='object','比对字段缺失');
          const diff=c.type==='number'?num(a).minus(num(z)):null,equal=diff?diff.abs().lte(num(c.tolerance)):String(a).trim()===String(z).trim();
          return {...base,local:a,value:z,diff:diff?.toString(),state:equal?'通过':'差异',reason:equal?'':c.bill+' 与 '+c.remote+' 不一致'};
        }catch(e){
          return {...base,state:'待复核',reason:e instanceof InputError?e.message:'字段读取失败'};
        }
      });
    }catch(e){
      return [{api:api.name,state:'待复核',reason:e instanceof InputError?e.message:'接口读取失败'}];
    }
  };
}

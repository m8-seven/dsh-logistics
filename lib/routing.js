export function identify(profiles,names,now=new Date()){
  const extras=(status,message,code='',period='',roles=[])=>({status,message,code,period,roles});
  if(!Array.isArray(names)||names.length>25||names.some(n=>typeof n!=='string'||n.length>220||!n.toLowerCase().endsWith('.xlsx')||/[\\/:*\x00-\x1f]/.test(n)||n.startsWith('~$')))return extras('conflict','每批最多 25 个 .xlsx 文件，请移除临时文件或不合规的文件名。');
  if(new Set(names.map(n=>n.normalize('NFC').toLowerCase())).size!==names.length)return extras('conflict','文件名重复，请移除重复的文件。');
  if(!names.length)return extras('waiting','请上传账单和报价。');
  const billsNamed=names.filter(n=>/^\d+-\d{1,2}月账单\.xlsx$/i.test(n));
  if(billsNamed.length){
    const bill=billsNamed[0], [,code,month]=bill.match(/^(\d+)-(\d{1,2})月/);
    if(billsNamed.length!==1||!profiles.some(p=>p.code===code)||+month<1||+month>12)return extras('conflict','请选择已配置渠道的一份月份账单');
    const quotes=names.filter(n=>n!==bill);
    if(!quotes.length)return extras('waiting','请继续上传带日期的报价表或 ZIP',code);
    if(quotes.some(n=>!n.startsWith(code+'-')||!/(20\d\d)年\d{1,2}月\d{1,2}日/.test(n)))return extras('conflict','报价文件需要同渠道编号和年月日');
    const latest=quotes.map(n=>n.match(/(20\d\d)年(\d{1,2})月/)).sort((a,b)=>Number(b[1])-Number(a[1])||Number(b[2])-Number(a[2]))[0];
    return extras('ready','文件齐全',code,latest[1]+month.padStart(2,'0'),names.map(name=>({name,role:name===bill?'bill':'quote'})));
  }
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const month='(?:0[1-9]|1[0-2])';
  function match(mask,code,name,period){
    const fields=[],parts={period:period||'\\d{4}'+month,yyyy:period?.slice(0,4)||'\\d{4}',mm:period?.slice(4)||month,date:'\\d{4}'+month+'(?:0[1-9]|[12]\\d|3[01])'};
    const pattern=Array.from(mask.trim().matchAll(/\{[^{}]+\}|./gu),([ch])=>{
      if(ch==='{code}')return escape(code);
      if(ch[0]==='{'){
        const k=ch.slice(1,-1); if(!Object.hasOwn(parts,k))return '(?!)';fields.push(k);return '('+parts[k]+')';
      }
      return ch==='*'?'.*':ch==='?'?'.':escape(ch);
    }).join('');
    const hit=new RegExp('^'+pattern+'$','iu').exec(name);
    if(!hit)return null;
    const periods=[],years=[],months=[];
    fields.forEach((k,i)=>{
      const v=hit[i+1];if(k==='period'||k==='date')periods.push(v.slice(0,6));if(k==='yyyy')years.push(v);if(k==='mm')months.push(v);
    });
    years.forEach(y=>months.forEach(m=>periods.push(y+m)));
    return periods;
  }
  const filesFor=(p,period)=>names.map(name=>{
    const hits=mask=>mask.split(/\r?\n/).filter(l=>l.trim()).map(l=>match(l,p.code,name,period)).filter(Boolean);
    const b=hits(p.billPattern),q=hits(p.quotePattern);
    return {name,role:b.length&&q.length?'ambiguous':b.length?'bill':q.length?'quote':'unknown',periods:b.flat()};
  });
  const candidates=profiles.map(p=>({p,files:filesFor(p)}));
  const eligible=candidates.filter(c=>c.files.every(f=>f.role!=='unknown'));
  if(!eligible.length){
    const unknown=names.filter((_,i)=>candidates.every(c=>c.files[i].role==='unknown'));
    return extras('conflict',unknown.length?'没有规则匹配：'+unknown.join('、'):'文件属于不同渠道，请按渠道和账期分批上传。');
  }
  if(eligible.length>1){
    if(eligible.every(c=>c.files.every(f=>f.role==='quote')))return extras('waiting','已收到报价，请补传账单以识别渠道。');
    return extras('conflict','文件同时匹配渠道 '+eligible.map(c=>c.p.code).join('、')+'，请调整重叠的文件名规则。');
  }
  const {p,files}=eligible[0],roles=files.map(({name,role})=>({name,role}));
  const state=(status,message,period='')=>extras(status,message,p.code,period,roles);
  if(files.some(f=>f.role==='ambiguous'))return state('conflict','同一文件同时命中两种格式，请区分账单和报价的文件名规则。');
  const bills=files.filter(f=>f.role==='bill');
  if(!bills.length)return state('waiting','已收到报价，请补传账单。');
  if(bills.length>1)return state('conflict','一批只能核对一份账单，请移除多余账单。');
  const bill=bills[0],detected=new Set(bill.periods);
  if(!detected.size){
    for(const m of bill.name.matchAll(/(?<!\d)((?:19|20)\d{2})[-_.年 ]?(0?[1-9]|1[0-2])月?(?!\d)/gu))detected.add(m[1]+m[2].padStart(2,'0'));
  }
  let period=detected.size===1?[...detected][0]:'';
  if(p.periodMode==='fixed')period=p.fixedPeriod;
  if(p.periodMode==='current'){
    const pieces=new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).formatToParts(now);
    period=pieces.find(x=>x.type==='year').value+pieces.find(x=>x.type==='month').value;
  }
  if(!/^\d{4}(0[1-9]|1[0-2])$/.test(period))return state('conflict','账期不明确。请在配置中标注账单年月或指定固定账期。');
  const wrong=filesFor(p,period).find((f,i)=>f.role!==files[i].role);
  if(wrong)return state('conflict','文件与账期 '+period+' 不匹配：'+wrong.name,period);
  const missing=Number(p.minQuotes??1)-(files.length-1);
  return missing>0?state('waiting','还需上传 '+missing+' 份报价。',period):state('ready','文件齐全，自动核对中。',period);
}

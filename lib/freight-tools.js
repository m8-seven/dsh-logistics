import ExcelJS from './excel.js';

const headers=['原账单行号','客户单号','账单单价','报价单价','差额（账单－报价）','异常原因','报价来源（文件、工作表及单元格或图片分栏）'];
const endpoint='http://192.168.72.10:8080/jeecg-boot/logistics/logisticsInfo/allList';
const clean=v=>String(v??'').trim();
function cellValue(cell){
  const v=cell.value;
  if(v instanceof Date)return v.toISOString().slice(0,10);
  if(v&&typeof v==='object')return v.result??v.text??v.richText?.map(t=>t.text).join('')??cell.text;
  return v;
}
export function freightTools(store){
  const db=store.db;
  db.exec('CREATE TABLE IF NOT EXISTS freight_inputs(session TEXT, file TEXT, bytes BLOB, PRIMARY KEY(session,file)); CREATE TABLE IF NOT EXISTS freight_rows(session TEXT,file TEXT,sheet TEXT,rownum INTEGER,data TEXT,PRIMARY KEY(session,file,sheet,rownum)); CREATE TABLE IF NOT EXISTS freight_exports(session TEXT,file TEXT,sheet TEXT,job TEXT,PRIMARY KEY(session,file,sheet))');
  let lastBook;
  const scans=new Map();
  function stage(session,file,bytes){
    if(!/^[-\w]{1,160}$/.test(session)||file.length>1500||!file.toLowerCase().endsWith('.xlsx'))throw Error('附件标识无效');
    db.prepare('INSERT OR IGNORE INTO freight_inputs VALUES(?,?,?)').run(session,file,bytes);
  }
  async function book(session,file){
    if(lastBook?.session===session&&lastBook.file===file)return lastBook.book;
    const data=db.prepare('SELECT bytes FROM freight_inputs WHERE session=? AND file=?').get(session,file);
    if(!data)throw Error('请选择本会话已上传的 Excel 文件');
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(data.bytes);lastBook={session,file,book:workbook};return workbook;
  }
  async function lookup(session,ids,signal){
    if(!Array.isArray(ids)||ids.length>250)throw Error('每次最多查询 250 个客户单号');
    if(!scans.has(session)){
      if(scans.size>=3)scans.delete(scans.keys().next().value);
      const task=(async()=>{
        const wanted=new Set();
        for(const {file} of db.prepare('SELECT file FROM freight_inputs WHERE session=?').all(session)){
          if(!/账单/.test(file.split('/').pop()))continue;
          for(const sh of (await book(session,file)).worksheets){let key;
            sh.eachRow(r=>{if(!key){r.eachCell((c,i)=>{if(clean(cellValue(c))==='客户单号')key=i})}
              else if(clean(cellValue(r.getCell(key))))wanted.add(clean(cellValue(r.getCell(key))))});
          }
        }
        if(!wanted.size)throw Error('未识别账单客户单号列');
        const index=new Map();let pages=1;
        const base=store.publicUrls().find(u=>u.name==='allList')?.url||endpoint;
        for(let page=1;page<=pages;page++){
          const url=new URL(base);url.searchParams.set('pageNo',page);url.searchParams.set('pageSize',1000);
          const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
          if(!response.ok)throw Error('allList HTTP '+response.status);
          const d=await response.json();if(!Array.isArray(d.records)||Number(d.current)!==page||!Number.isInteger(d.pages)||d.pages>1000)throw Error('allList 分页响应异常');
          pages=d.pages;
          for(const r of d.records)for(const k of new Set([r.shipmentNo,r.orderNo,r.serviceProviderNo,r.thirdPartyNo].map(clean))){
            if(!wanted.has(k))continue;const hits=index.get(k)||new Map();hits.set(r.id,{boxNum:r.boxNum,country:r.country,logisticsChannel:r.logisticsChannel,receivingWarehouse:r.receivingWarehouse});index.set(k,hits);
          }
        }return index;
      })();scans.set(session,task);task.catch(()=>{if(scans.get(session)===task)scans.delete(session)});
    }
    const index=await scans.get(session);return ids.map(id=>({id,records:[...(index.get(clean(id))?.values()||[])]}));
  }
  async function run(session,a,signal){
    if(!session)throw Error('缺少当前会话');
    if(a.action==='list')return db.prepare('SELECT file FROM freight_inputs WHERE session=? ORDER BY file').all(session);
    if(a.action==='lookup')return lookup(session,a.ids,signal);
    const w=await book(session,a.file);if(a.action==='sheets')return w.worksheets.map(s=>({name:s.name,rows:s.rowCount,cols:s.columnCount}));
    const sh=w.getWorksheet(a.sheet);if(!sh)throw Error('工作表不存在');
    if(a.action==='read'){
      const start=a.start??1,count=a.count??25;
      if(!Number.isInteger(start)||start<1||!Number.isInteger(count)||count<1||count>100)throw Error('按 1 至 100 行分段读取');
      const data=[];for(let n=start;n<=Math.min(sh.rowCount,start+count-1);n++){const cells={};sh.getRow(n).eachCell(c=>{cells[c.address]=cellValue(c)});data.push({row:n,cells})}return data;
    }
    if(!['next','record','export'].includes(a.action))throw Error('未知操作');
    const identity=[session,a.file,a.sheet];
    let key,head;sh.eachRow(r=>{if(!key)r.eachCell((c,i)=>{if(clean(cellValue(c))==='客户单号'){key=i;head=r.number}})});
    if(!key)throw Error('无法验证客户单号列');
    const included=[];sh.eachRow(r=>{if(r.number>head&&clean(cellValue(r.getCell(key))))included.push(r.number)});
    const seen=new Set(db.prepare('SELECT rownum FROM freight_rows WHERE session=? AND file=? AND sheet=?').all(...identity).map(r=>r.rownum));
    const pending=included.filter(n=>!seen.has(n));
    const next=pending.slice(0,12);
    if(!included.length)throw Error('账单没有可核对的客户单号行');
    if(a.action==='next')return {next,remaining:pending.length,total:included.length};
    if(a.action==='record'){
      const passed=a.passed??[],exceptions=a.rows??[];
      if(!Array.isArray(passed)||!Array.isArray(exceptions)||passed.length+exceptions.length>12)throw Error('每次只提交 next 分配的最多 12 行');
      const rows=[...passed.map(row=>({row,api:'一致',quote:'一致',yellow:[]})),...exceptions];
      const ids=new Set(rows.map(r=>r.row));
      if(!next.length||ids.size!==rows.length||ids.size!==next.length||next.some(n=>!ids.has(n)))throw Error('提交行须与本批一致，不得遗漏、重复或跨批。当前行号：'+next.join(','));
      const save=db.prepare('INSERT INTO freight_rows VALUES(?,?,?,?,?)');
      db.exec('BEGIN IMMEDIATE');
      try{for(const r of rows){
        if(!Number.isInteger(r.row)||r.row<1||r.row>sh.rowCount||!Array.isArray(r.yellow)||r.yellow.some(k=>!/^([A-Z]{1,3})$/.test(k)||sh.getColumn(k).number>sh.columnCount))throw Error('账单行或标黄色列无效');
        if(!['一致','差异','待复核'].includes(r.quote)||!['一致','差异','待复核'].includes(r.api))throw Error('每行需分别给出接口和报价结论');
        if(r.quote!=='一致'&&!clean(r.reason))throw Error('报价异常缺少说明');
        save.run(...identity,r.row,JSON.stringify(r));
      }db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
      if(pending.length===next.length)return run(session,{...a,action:'export'},signal);
      return {saved:next,next:pending.slice(12,24),remaining:pending.length-next.length};

    }
    const old=db.prepare('SELECT job FROM freight_exports WHERE session=? AND file=? AND sheet=?').get(...identity);if(old)return {download:'/api/freight/download?id='+old.job};
    const saved=new Map(db.prepare('SELECT rownum,data FROM freight_rows WHERE session=? AND file=? AND sheet=?').all(...identity).map(r=>[r.rownum,JSON.parse(r.data)]));
    const missing=included.filter(n=>!saved.has(n));if(!included.length||missing.length)throw Error('尚有未核对行：'+missing.slice(0,25).join(','));
    const out=new ExcelJS.Workbook();await out.xlsx.load(db.prepare('SELECT bytes FROM freight_inputs WHERE session=? AND file=?').get(session,a.file).bytes);
    const original=out.getWorksheet(a.sheet);for(const other of [...out.worksheets])if(other!==original)out.removeWorksheet(other.id);
    const detail=out.addWorksheet('第二步异常明细');detail.addRow(headers);
    const stats={total:included.length,passed:0,different:0,review:0,apis:1};
    for(const n of included){const r=saved.get(n);for(const col of r.yellow)original.getCell(col+n).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFF00'}};
      if(r.quote!=='一致')detail.addRow([n,clean(cellValue(original.getRow(n).getCell(key))),r.local??null,r.price??null,Number.isFinite(r.local)&&Number.isFinite(r.price)?Number((r.local-r.price).toFixed(6)):null,r.reason,r.source??'']);
      stats[[r.quote,r.api].includes('待复核')?'review':[r.quote,r.api].includes('差异')?'different':'passed']++;
    }
    detail.columns.forEach((col,i)=>col.width=[13,24,14,14,18,50,62][i]);detail.views=[{state:'frozen',ySplit:1}];
    const bytes=Buffer.from(await out.xlsx.writeBuffer()),name=a.file.split('/').pop(),filename=name.replace(/\.xlsx$/i,'_核对结果.xlsx');
    db.exec('BEGIN IMMEDIATE');try{const existing=db.prepare('SELECT job FROM freight_exports WHERE session=? AND file=? AND sheet=?').get(...identity);if(existing){db.exec('COMMIT');return {download:'/api/freight/download?id='+existing.job}}
      const id=store.newJob(name.split('-')[0],'',name);store.complete(id,filename,stats,bytes);db.prepare('INSERT INTO freight_exports VALUES(?,?,?,?)').run(...identity,id);db.exec('COMMIT');return {filename,download:'/api/freight/download?id='+id,stats};
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  return {stage,run};
}

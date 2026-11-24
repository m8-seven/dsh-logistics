import ExcelJS from './excel.js';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {need,InputError} from './config.js';
const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main',officeRel='http://schemas.openxmlformats.org/officeDocument/2006/relationships',packageRel='http://schemas.openxmlformats.org/package/2006/relationships',types='http://schemas.openxmlformats.org/package/2006/content-types';
const serialize=new XMLSerializer();
const excelCol=n=>{
  let s='';
  while(n>0){
    n--;
    s=String.fromCharCode(65+n%26)+s;
    n=Math.floor(n/26);
  }return s;
};

export function tableColumn(table,key){
  const cols=table.columns.filter(c=>key.startsWith('$')?'$'+c.letter===key.toUpperCase():c.name===key);
  need(cols.length===1,'工作表「'+table.sheet+'」列名缺失或重复：'+key+'。也可填写 $A 形式的列号。');
  return cols[0].letter;
}

export function openParts(bytes){
  try {
    let size=0,count=0;
    const parts=unzipSync(new Uint8Array(bytes),{filter:e=>{
      size+=e.originalSize;count++;need(size<=192*1024*1024&&count<=12000,'工作簿解压后过大');return true;
    }});
    need(parts['xl/workbook.xml']&&parts['[Content_Types].xml'],'文件不是有效的 XLSX 工作簿');
    return parts;
  }catch(e){
    if(e instanceof InputError)throw e;
    throw new InputError('无法读取 Excel，请确认是有效的未加密 .xlsx 文件');
  }
}
function cellValue(cell){
  let v=cell.value;
  if(v&&typeof v==='object'&&('formula' in v||'sharedFormula' in v))v=v.result;
  if(v instanceof Date)return v.toISOString().slice(0,10);
  if(v&&typeof v==='object'){
    if(Array.isArray(v.richText))v=v.richText.map(r=>r.text).join('');
    else if('text'in v)v=v.text;
    else return null;
  }
  if(typeof v==='number'&&Number.isSafeInteger(v)&&/^0{2,}$/.test(cell.numFmt||''))return String(v).padStart(cell.numFmt.length,'0');
  return v??null;
}

export async function loadTables(file,p,role,offset=0){
  openParts(file.bytes);
  const wb=new ExcelJS.Workbook();
  try{
    await wb.xlsx.load(file.bytes);
  }catch{
    throw new InputError('无法解析 Excel：'+file.name);
  }
  const visible=wb.worksheets.filter(s=>s.state==='visible'||!s.state);
  const glob=s=>new RegExp('^'+Array.from(s,c=>c==='*'?'.*':c==='?'?'.':c.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g,'\\$&')).join('')+'$','iu');
  const selected=role==='bill'?(p.billSheet?[wb.getWorksheet(p.billSheet)].filter(Boolean):visible.slice(0,1)):visible.filter(s=>glob(p.quoteSheet||'*').test(s.name));
  need(selected.length>0,file.name+' 未找到配置的工作表');
  const header=role==='bill'?p.billHeader:p.quoteHeader;
  return selected.map((sheet,k)=>{
    const titles=sheet.getRow(header),columns=[];
    titles.eachCell((cell,n)=>{
      const v=cellValue(cell);if(v!==null&&String(v).trim())columns.push({letter:excelCol(n),name:String(v).trim()});
    });
    need(columns.length&&columns.length<=300,'表头无有效字段或列数超限：'+sheet.name);
    const rows=[];sheet.eachRow((row,n)=>{
      if(n<=header)return;const cells=Object.fromEntries(columns.map(c=>[c.letter,cellValue(row.getCell(c.letter))]));if(Object.values(cells).some(x=>x!==null&&x!==''))rows.push({n,cells});
    });
    need(rows.length<=120000,'工作表数据超过 12 万行：'+sheet.name);
    return {id:role==='bill'?'B':'Q'+offset+'_'+k,file:file.name,sheet:sheet.name,header,columns,rows};
  });
}
const xml=(s)=>String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);
function sheetXML(rows){
  const cols=rows[0].map((_,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+(i===0?22:i===rows[0].length-1?55:20)+'" customWidth="1"/>').join('');
  const data=rows.map((r,i)=>'<row r="'+(i+1)+'">'+r.map((v,j)=>{
    const a=excelCol(j+1)+(i+1);if(typeof v==='number'&&Number.isFinite(v))return '<c r="'+a+'"><v>'+v+'</v></c>';return '<c r="'+a+'" t="inlineStr"><is><t xml:space="preserve">'+xml(String(v??'').slice(0,32767))+'</t></is></c>';
  }).join('')+'</row>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="'+main+'"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>'+cols+'</cols><sheetData>'+data+'</sheetData><autoFilter ref="A1:'+excelCol(rows[0].length)+rows.length+'"/></worksheet>';
}

export function appendSheets(bytes,added){
  const parts=openParts(bytes),bookKey='xl/workbook.xml',rsKey='xl/_rels/workbook.xml.rels',ctKey='[Content_Types].xml';
  const read=k=>new DOMParser().parseFromString(strFromU8(parts[k]),'application/xml');
  const book=read(bookKey),rels=read(rsKey),ct=read(ctKey),root=book.getElementsByTagNameNS(main,'sheets')[0];
  need(root,'仅支持标准 XLSX 工作簿');
  const old=Array.from(root.getElementsByTagNameNS(main,'sheet')),names=new Set(old.map(s=>s.getAttribute('name').toLowerCase()));
  const ids=new Set(Array.from(rels.getElementsByTagNameNS(packageRel,'Relationship')).map(r=>r.getAttribute('Id')));
  let id=Math.max(0,...old.map(s=>Number(s.getAttribute('sheetId'))))+1;
  for(const item of added){
    let name=item.name,i=2;
    while(names.has(name.toLowerCase()))name=item.name+'_'+i++;
    names.add(name.toLowerCase());
    let n=id;
    while(parts['xl/worksheets/sheet'+n+'.xml']||ids.has('rIdFreight'+n))n++;
    const rid='rIdFreight'+n,dest='worksheets/sheet'+n+'.xml';
    ids.add(rid);
    const sh=book.createElementNS(main,'sheet');
    sh.setAttribute('name',name);
    sh.setAttribute('sheetId',String(id++));
    sh.setAttributeNS(officeRel,'r:id',rid);
    root.appendChild(sh);
    const rel=rels.createElementNS(packageRel,'Relationship');
    rel.setAttribute('Id',rid);
    rel.setAttribute('Type',officeRel+'/worksheet');
    rel.setAttribute('Target',dest);
    rels.documentElement.appendChild(rel);
    const ext=ct.createElementNS(types,'Override');
    ext.setAttribute('PartName','/xl/'+dest);
    ext.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
    ct.documentElement.appendChild(ext);
    parts['xl/'+dest]=strToU8(sheetXML(item.rows));
  }
  for(const [k,doc] of [[bookKey,book],[rsKey,rels],[ctKey,ct]])parts[k]=strToU8(serialize.serializeToString(doc));
  return Buffer.from(zipSync(parts,{level:4}));
}

import ExcelJS from './excel.js';
import {unzipSync} from 'fflate';
import {need} from './config.js';
export const standardPrompt='按客户单号查 allList，比较 boxNum、country 和去掉开头四位数字的 logisticsChannel，与件数、目的国、产品不一致的单元格标黄。按收货日期选生效报价，按运输方式、仓库和重量档匹配单价。快船卡派/6000-快提-T 对应快船卡派-T（合德&ZIM统配）。列出报价来源、单价差额和未匹配原因。';
export function expandQuotes(files){
  const expanded=[];
  let total=0;
  for(const file of files){
    if(!/\.zip$/i.test(file.name)){expanded.push(file);continue}
    const prefix=file.name.match(/^(\d+)(?!\d)/)?.[1];
    let count=0;
    const entries=unzipSync(file.bytes,{filter:e=>{
      if(!/\.xlsx$/i.test(e.name)||/(^|\/)(~\$|__MACOSX)/.test(e.name))return false;
      total+=e.originalSize;count++;
      need(total<=64*1024**2&&count<=24&&e.originalSize<=24*1024**2,'报价压缩包超出容量限制');return true;
    }});
    need(count,'压缩包内没有 Excel 报价');
    for(const [path,bytes] of Object.entries(entries)){
      let name=path.split(/[\\/]/).pop();
      if(!/年/.test(name)&&Array.from(name).every(c=>c.charCodeAt(0)<256))name=new TextDecoder('gbk').decode(Uint8Array.from(name,c=>c.charCodeAt(0)));
      if(prefix&&!/^\d+-/.test(name))name=prefix+'-'+name;
      expanded.push({name,bytes});
    }
  }
  return expanded;
}
export async function parseCards(files){
  const cards=[];
  for(const file of files){
    const d=file.name.match(/(20\d\d)年(\d{1,2})月(\d{1,2})日/);
    need(d,'报价文件名缺少日期：'+file.name);
    const date=d[1]+'-'+d[2].padStart(2,'0')+'-'+d[3].padStart(2,'0');
    const book=new ExcelJS.Workbook();await book.xlsx.load(file.bytes);
    const rates=[];
    for(const sheet of book.worksheets){
      let header=[],channelCol=0;
      sheet.eachRow(row=>{
        const values=[];row.eachCell((c,i)=>{values[i]=String(c.value?.richText?.map(t=>t.text).join('')??c.value?.result??c.value?.text??c.value??'').trim()});
        const idx=values.findIndex(v=>['下单渠道','运输方式'].includes(v));
        if(idx>0){header=values;channelCol=idx;return}
        const channel=values[channelCol];if(!channel)return;
        const tiers={};let warehouse=values[header.indexOf('仓库')]||'';
        header.forEach((h,i)=>{
          const v=values[i];if(!v||!/^\d+(\.\d+)?$/.test(v))return;
          const t=h.match(/^(\d+)\s*KG\+$/i);
          const price=[Number(v),row.getCell(i).address];
          if(t||h==='单价')tiers[t?Number(t[1]):0]=price;
          else if(header[channelCol]==='运输方式'&&!['重量','件数','计费重','序号'].includes(h))
            rates.push({channel,warehouse:h,tiers:{0:price},sheet:sheet.name});
        });
        if(Object.keys(tiers).length)rates.push({channel,warehouse,country:values[header.indexOf('国家')]||'',restricted:header.some(h=>/分区|邮编/.test(h)),sheet:sheet.name,tiers});
      });
    }
    cards.push({date,file:file.name,rates});
  }
  return cards.sort((a,b)=>a.date.localeCompare(b.date));
}

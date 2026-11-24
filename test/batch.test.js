import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import ExcelJS from '../lib/excel.js';
import {freightTools} from '../lib/freight-tools.js';

test('分配真实行号、整批校验、自动交付两张表',async()=>{
  const db=new DatabaseSync(':memory:');
  let completed;
  const service=freightTools({db,newJob:()=>'test',complete:(id,name,stats,bytes)=>{completed={stats,bytes}}});
  const input=new ExcelJS.Workbook(), sheet=input.addWorksheet('原账单');
  sheet.addRow(['客户单号','产品']);for(let i=1;i<=19;i++){if(i===4)sheet.addRow([]);sheet.addRow(['样例'+i,'产品']);}
  const file='1035-10月账单.xlsx';service.stage('test',file,await input.xlsx.writeBuffer());
  const action=(name,args={})=>service.run('test',{action:name,file,sheet:'原账单',...args},new AbortController().signal);
  const first=await action('next');assert.equal(first.next.length,12);assert(!first.next.includes(5));
  await assert.rejects(action('record',{passed:first.next.slice(1)}));
  await assert.rejects(action('record',{passed:[...first.next,first.next[0]]}));
  await assert.rejects(action('record',{passed:first.next.slice(1),rows:[{row:first.next[0],api:'差异',quote:'差异',yellow:['X'],reason:'示例'}]}));
  assert.deepEqual(await action('next'),first);await assert.rejects(action('export'));
  const result=await action('record',{passed:first.next.slice(1),rows:[{row:first.next[0],api:'差异',quote:'差异',yellow:['B'],reason:'单价差异',source:'报价!B6',local:12,price:11}]});
  assert.equal(result.remaining,7);const last=await action('record',{passed:result.next});
  assert(last.download);assert.equal(completed.stats.total,19);const out=new ExcelJS.Workbook();await out.xlsx.load(completed.bytes);
  assert.deepEqual(out.worksheets.map(s=>s.name),['原账单','第二步异常明细']);assert.equal(out.worksheets[1].rowCount,2);
  assert.equal(out.worksheets[0].getCell('B2').fill.fgColor.argb,'FFFFFF00');db.close();
});

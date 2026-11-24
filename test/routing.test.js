import test from 'node:test';
import assert from 'node:assert/strict';
import {newProfile,validateProfile} from '../lib/config.js';
import {identify} from '../lib/routing.js';
const p={...newProfile('1032'),minQuotes:3},b='1032_账单_202610.xlsx',q=n=>'1032_报价_'+n+'.xlsx';
test('账单、报价可分次补传，到齐后才执行',()=>{
  assert.equal(identify([p],[]).status,'waiting');
  assert.equal(identify([p],[q(1)]).status,'waiting');
  assert.match(identify([p],[b,q(1)]).message,/2 份/);
  const r=identify([p],[q(1),q(2),q(3),b]);assert.equal(r.status,'ready');assert.equal(r.period,'202610');assert.equal(r.code,'1032');
});
test('重复、未知、混合、歧义和跨账期不可提交',()=>{
  assert.equal(identify([p],[b,b,q(1)]).status,'conflict');
  assert.equal(identify([p],[b,'xx.xlsx']).status,'conflict');
  assert.equal(identify([p,newProfile('1035')],[b,'1035_报价_1.xlsx']).status,'conflict');
  assert.equal(identify([p,{...p,code:'99',billPattern:'1032_账单_{period}.xlsx',quotePattern:'1032_报价_*.xlsx'}],[b,q(1)]).status,'conflict');
  assert.equal(identify([{...p,quotePattern:'{code}_报价_{period}.xlsx'}],[b,q('202609')]).status,'conflict');
});
test('可设置固定、当前或从分开的年与月识别账期',()=>{
  const fixed={...p,minQuotes:1,billPattern:'账单.xlsx',periodMode:'fixed',fixedPeriod:'202610'};
  assert.equal(identify([fixed],['账单.xlsx',q(1)]).period,'202610');
  assert.equal(identify([{...fixed,periodMode:'current'}],['账单.xlsx',q(1)],new Date('2026-10-31T18:00:00Z')).period,'202611');
  assert.equal(identify([{...p,minQuotes:1,billPattern:'账单_{yyyy}年{mm}月.xlsx'}],['账单_2026年10月.xlsx',q(1)]).period,'202610');
  assert.throws(()=>validateProfile({...fixed,fixedPeriod:'202699'}));
});

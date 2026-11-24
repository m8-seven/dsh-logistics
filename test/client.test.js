import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
test('客户端注册原生侧栏、主界面和插件配置入口',async()=>{
  let mod;runInNewContext(await readFile(new URL('../dist/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:m=>{
    mod=m;
  }}}});
  assert.equal(mod.id,'dsh-freight-reconcile');const entries=[];mod.factory(()=>({})).apply({effect:g=>[...g()],slots:{inject:(_,f)=>f(),register:(s,c)=>{
    entries.push(s);assert.equal(typeof c,'function');return ()=>{
    };
  }}});
  assert.deepEqual(entries.map(s=>s.name),['main','sidebar.panellist','plugins.bundle.config']);assert.equal(entries[0].key,entries[1].id);
});

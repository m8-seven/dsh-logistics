import {readFile,writeFile,mkdir} from 'node:fs/promises';
const at=p=>new URL('../'+p,import.meta.url);
const load=p=>readFile(at(p),'utf8');
const [app,native,markup,css,dispatch]=await Promise.all(['web/app.js','web/native.js','web/panel.html','web/style.css','web/dispatch.js'].map(load));
const helpers=await load('web/inputs.js');
const vendor=await load('web/fflate.umd.js');
const bundle='window.__ModuleLoader__.load({id:"dsh-freight-reconcile",factory:function(require){\n'+'const freightZip=(()=>{const module={exports:{}};const exports=module.exports;'+vendor+'\n;return module.exports})();\n'+helpers+'\n'+dispatch.replace('export async function','async function')+'\n'+app.replace('export function mountWorkbench','function mountWorkbench')+'\n'+native.replace('export function native','function native')+'\nreturn native(require("react"),mountWorkbench,'+JSON.stringify(markup)+','+JSON.stringify(css)+');\n}});\n';
await mkdir(at('dist/'),{recursive:true});
await writeFile(at('dist/client.js'),bundle);

const uploadPaths=new WeakMap();
function attachmentPath(file){return uploadPaths.get(file)||file.webkitRelativePath||file.name}
function imageType(file){
  const ext=file.name.split('.').pop().toLowerCase();
  return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'})[ext]||'';
}
async function unpackInputs(inputs){
  const files=[];
  for(const file of inputs){
    const path=attachmentPath(file);
    if(/(^|\/)(__MACOSX|\.DS_Store|~\$)/.test(path))continue;
    if(!/\.zip$/i.test(file.name)){files.push(file);continue}
    let total=0;
    const entries=freightZip.unzipSync(new Uint8Array(await file.arrayBuffer()),{filter:e=>{
      if(e.name.endsWith('/')||/(^|\/)(__MACOSX|\.DS_Store|~\$)/.test(e.name))return false;
      total+=e.originalSize;
      if(total>256*1024**2)throw Error(file.name+' 解压后超过 256 MiB，请直接选择文件夹');
      return true;
    }});
    for(let [name,bytes] of Object.entries(entries)){
      if(!/[^\x00-\xff]/.test(name)&&/[\x80-\xff]/.test(name))name=new TextDecoder('gbk').decode(Uint8Array.from(name,c=>c.charCodeAt(0)));
      const leaf=name.split(/[\\/]/).pop();if(!leaf)continue;
      const child=new File([bytes],leaf);
      uploadPaths.set(child,path+'/'+name);files.push(child);
    }
  }
  return files;
}
async function droppedFiles(transfer){
  const fallback=[...transfer.files],entries=[...transfer.items].map(i=>i.webkitGetAsEntry?.()).filter(Boolean);
  if(!entries.length)return fallback;
  const result=[];
  async function visit(entry,parent){
    const path=parent+entry.name;
    if(entry.isFile){
      const file=await new Promise((ok,fail)=>entry.file(ok,fail));
      uploadPaths.set(file,path);result.push(file);return;
    }
    const reader=entry.createReader();
    for(;;){
      const children=await new Promise((ok,fail)=>reader.readEntries(ok,fail));
      if(!children.length)break;
      for(const child of children)await visit(child,path+'/');
    }
  }
  for(const entry of entries)await visit(entry,'');
  return result;
}
function channelFor(files,channels,override){
  const codes=new Set();
  for(const file of files){
    for(const part of attachmentPath(file).split(/[\\/]/)){
      const hit=part.match(/^(\d{3,8})(?=$|[-_.\s]|报价|账单)/);
      if(hit)codes.add(hit[1]);
    }
  }
  if(codes.size>1)return {status:'conflict',message:'发现多个渠道 '+[...codes].join('、')+'，请按渠道分别提交。'};
  const code=[...codes][0]||override;
  if(!channels.some(p=>p.code===code))return {status:'waiting',message:code?'请先在渠道配置中添加 '+code:'请选择本批次所属渠道。'};
  return {status:'ready',code,message:'已添加 '+files.length+' 个附件，可继续添加或开始核对。'};
}

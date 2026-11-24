export function mountWorkbench(root,initial='run'){
  const $=s=>root.querySelector(s),$all=s=>Array.from(root.querySelectorAll(s));
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]),attr=esc;
  const roles={bill:'账单',quote:'报价',unknown:'未识别',ambiguous:'规则冲突'};
  const fmtDate=x=>new Date(x).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const badge=(s,k='')=>'<span class="badge '+k+'">'+esc(s)+'</span>';
  const head=(t,d,a='')=>'<div class="pagehead"><div><h1>'+esc(t)+'</h1><p>'+esc(d)+'</p></div>'+a+'</div>';
  const table=(titles,rows,empty)=>rows.length?'<div class="scroll"><table><thead><tr>'+titles.map(t=>'<th>'+esc(t)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<p class="empty">'+esc(empty)+'</p>';
  const button=(label,id)=>'<button type="button" class="primary" id="'+id+'">'+esc(label)+'</button>';
  const field=(label,control,hint='',wide=false)=>'<label class="field '+(wide?'wide':'')+'"><span>'+esc(label)+'</span>'+control+(hint?'<small>'+esc(hint)+'</small>':'')+'</label>';
  const input=(name,value='',attrs='')=>'<input name="'+name+'" value="'+attr(value)+'" '+attrs+'>';
  const select=(name,opts,v)=>'<select name="'+name+'">'+opts.map(([k,t])=>'<option value="'+attr(k)+'" '+(v===k?'selected':'')+'>'+esc(t)+'</option>').join('')+'</select>';
  const area=(name,v='',rows=3)=>'<textarea name="'+name+'" rows="'+rows+'">'+esc(v)+'</textarea>';
  const yes=(name,checked,label)=>'<label class="check wide"><input type="checkbox" name="'+name+'" '+(checked?'checked':'')+'>'+esc(label)+'</label>';
  const app={page:initial,data:null,code:'',apis:[],files:[],route:null,busy:false,key:''};
  let disposed=false,fileSeq=0,loadSeq=0,saveAction=null;
  const announce=(s,bad=false)=>{
    if(disposed)return;
    const n=$('#notice');
    n.hidden=false;
    n.className=bad?'notice error':'notice';
    n.textContent=s;
  };
  const guarded=fn=>async(...args)=>{
    try{
      await fn(...args);
    }catch(e){
      announce(e.message,true);
    }
  };
  async function req(path,opt={}){
    const options={...opt,headers:{'x-freight-client':'panel'}};
    if(options.body&&!(options.body instanceof FormData)){
      options.headers['content-type']='application/json';
      options.body=JSON.stringify(options.body);
    }
    const res=await fetch('/api/freight/'+path,options);
    let data;
    try{
      data=await res.json();
    }catch{
      throw Error('Harness 插件服务未响应，请刷新窗口。');
    }
    if(!res.ok)throw Error(data.error||'请求失败');
    return data;
  }
  const post=(path,body)=>req(path,{method:'POST',body});
  async function sync(){
    const n=++loadSeq, options={signal:AbortSignal.timeout(20000)}, data=await req('state',options);
    if(disposed||n!==loadSeq)return;
    if(!data.channels.some(c=>c.code===app.code))app.code=(data.channels.find(c=>c.code==='1032')||data.channels[0])?.code||'';
    app.data=data;
    render();
    req('models',options).then(models=>{if(!disposed&&n===loadSeq){app.models=models;const el=$('[name=harnessModel]');if(el)el.innerHTML=modelOptions()}}).catch(()=>{});
    render();
  }
  function render(){
    if(!app.data)return;
    $all('[data-page]').forEach(b=>{
      if(b.dataset.page===app.page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
    });
    if(app.page==='run')runPage();
    else if(app.page==='channels')channelList();
    else if(app.page==='apis')apiList();
    else apiList();
  }
  $all('[data-page]').forEach(b=>b.onclick=()=>{
    app.page=b.dataset.page;$('#notice').hidden=true;render();if(app.page==='run'&&app.files.length&&!app.busy)guarded(check)();
  });
  const actions=id=>'<button type="button" class="link" data-edit="'+attr(id)+'">编辑</button> <button type="button" class="link danger" data-del="'+attr(id)+'">删除</button>';
  function dialog(title,body,fn,cta='保存配置'){
    $('#dialogTitle').textContent=title;
    $('#dialogBody').innerHTML=body;
    $('#formError').hidden=true;
    $('#save').textContent=cta;
    $('#save').disabled=false;
    saveAction=fn;
    $('#dialog').showModal();
  }
  $all('[data-close]').forEach(b=>b.onclick=()=>$('#dialog').close());
  $('#editor').onsubmit=async e=>{
    e.preventDefault();
    const save=$('#save');
    save.disabled=true;
    $('#formError').hidden=true;
    try{
      await saveAction(Object.fromEntries(new FormData(e.target)));
      if(!disposed)$('#dialog').close();
    }
    catch(err){
      if(!disposed){
        $('#formError').textContent=err.message;
        $('#formError').hidden=false;
      }
    }finally{
      if(!disposed)save.disabled=false;
    }
  };
  function remove(v,isApi){
    dialog('删除「'+v.name+'」',isApi?'删除后，新任务会使用更新后的接口配置。':'此操作同时删除该渠道关联的接口。已生成的结果仍可下载。',async()=>{
      await post(isApi?'api-remove':'channel-remove',{id:isApi?v.id:v.code,rev:v.rev});await sync();announce('配置已删除');
    },'确认删除');
  }
  function channelList(){
    $('#page').innerHTML=head('渠道配置','按文件名识别渠道，再使用该渠道的核对提示词。',button('新增渠道','addChan'))+
    '<section class="card">'+table(['渠道','文件识别','核对提示词','操作'],app.data.channels.map(p=>[esc(p.code),esc(p.billPattern)+'<br>'+esc(p.quotePattern),esc(p.prompt),actions(p.code)]),'暂无渠道。')+'</section>';
    $('#addChan').onclick=()=>channelEditor();
    $all('[data-edit]').forEach(b=>b.onclick=()=>channelEditor(app.data.channels.find(p=>p.code===b.dataset.edit)));
    $all('[data-del]').forEach(b=>b.onclick=()=>remove(app.data.channels.find(p=>p.code===b.dataset.del),false));
  }
  function channelEditor(old){
    const v=old||app.data.template,ctl=field('渠道编号',input('code',v.code,'required '+(old?'readonly':'')))+
    field('账单文件名',area('billPattern',v.billPattern,2))+field('报价文件名',area('quotePattern',v.quotePattern,2))+
    field('渠道提示词',area('prompt',v.prompt,6),'可以引用公共接口的名称或地址。',true);
    dialog(old?'编辑渠道 '+v.code:'新增渠道','<div class="fields">'+ctl+'</div>',async data=>{
      await post('channel-save',{...v,...data,name:v.name||data.code,requireApi:false,...(old?{rev:old.rev}:{})});app.code=data.code;await sync();announce('渠道配置已保存');
    });
  }
  function apiList(){
    const urls=app.data.publicUrls||[];
    $('#page').innerHTML=head('公共接口','所有渠道的提示词均可引用这里的接口。',button('添加接口','addApi'))+
    table(['名称','地址','操作'],urls.map((u,i)=>[esc(u.name),esc(u.url),'<button data-url="'+i+'">编辑</button>']),'暂无公共接口');
    const edit=(v={})=>dialog('公共接口',field('名称',input('name',v.name,'required '+(v.name?'readonly':'')))+field('接口地址',input('url',v.url,'required')),async d=>{await post('public-url',d);await sync()});
    $('#addApi').onclick=()=>edit();$all('[data-url]').forEach(b=>b.onclick=()=>edit(urls[Number(b.dataset.url)]));
  }
  function modelOptions(){
    return '<option value="">使用 Harness 默认模型</option>'+(app.models||[]).map(m=>{const k=JSON.stringify([m.provider,m.id]);return '<option value="'+attr(k)+'" '+(app.selection===k?'selected':'')+'>'+esc(m.provider+' / '+m.id)+'</option>'}).join('');
  }
  function runPage(){
    $('#page').innerHTML=head('上传核对','可选择文件、文件夹或 ZIP。图片报价将随账单提交给所选模型。')+
    '<section class="card cardpad"><label>识别模型 <select name="harnessModel">'+modelOptions()+'</select></label><label id="drop" class="drop"><span class="glyph" aria-hidden="true">↑</span><strong>选择文件，或拖入文件和文件夹</strong><span class="hint">支持图片报价及其他附件，可分次添加</span><input type="file" multiple id="files" aria-label="上传账单和报价"></label><label>选择文件夹 <input id="folder" type="file" webkitdirectory multiple></label><label>渠道 '+select('batchChannel',[['','自动识别'],...app.data.channels.map(p=>[p.code,p.code+' · '+p.name])],app.override||'')+'</label><p id="recognition" aria-live="polite"></p><div id="list"></div></section>'+
    '<section class="card"><div class="cardhead"><h2>核对结果</h2><button class="link" type="button" id="refresh">刷新</button></div><div id="jobs"></div></section>';
    $('[name=harnessModel]').onchange=e=>{app.selection=e.target.value;app.batch=null};
    $('#refresh').onclick=guarded(refreshJobs);
    $('#files').onchange=guarded(async e=>{
      const list=[...e.target.files];e.target.value='';await appendFiles(list);
    });
    $('#folder').onchange=$('#files').onchange;
    $('[name=batchChannel]').onchange=guarded(async e=>{app.override=e.target.value;app.batch=null;await check()});
    const drop=$('#drop');
    drop.ondragover=e=>{
      e.preventDefault();
      if(!app.busy)drop.classList.add('over');
    };
    drop.ondragleave=()=>drop.classList.remove('over');
    drop.ondrop=guarded(async e=>{
      e.preventDefault();drop.classList.remove('over');await appendFiles(await droppedFiles(e.dataTransfer));
    });
    paintBatch();
    paintJobs();
  }
  function paintBatch(){
    const box=$('#recognition');
    if(!box)return;
    const r=app.route;
    $('#files').disabled=app.busy;
    box.className=r?.status==='conflict'?'conflict':'';
    box.textContent=r?[r.code&&'渠道 '+r.code,r.period&&'账期 '+r.period,r.message].filter(Boolean).join(' · '):'';
    if((r?.retry||r?.status==='ready')&&!app.busy){
      const b=document.createElement('button');
      b.type='button';
      b.className='link';
      b.textContent=r.retry?'重试上传':'开始核对';
      b.onclick=guarded(()=>check(true));
      box.append(' ',b);
    }
    $('#list').innerHTML=app.files.map((f,i)=>{
      const role=r?.roles?.find(v=>v.name===f.name)?.role;
      return '<div class="fileline"><span>'+esc(attachmentPath(f))+'</span><span>'+(role?badge(roles[role]):'')+
      (app.busy?'':' <button type="button" class="link" data-remove="'+i+'" aria-label="移除 '+attr(f.name)+'">移除</button>')+'</span></div>';
    }).join('');
    $all('[data-remove]').forEach(b=>b.onclick=guarded(async()=>{
      app.files.splice(Number(b.dataset.remove),1);app.key=makeKey();app.batch=null;await check();
    }));
  }
  function makeKey(){
    if(crypto.randomUUID)return crypto.randomUUID();
    const b=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
    return b.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
  }
  async function appendFiles(files){
    if(!files.length||app.busy)return;
    if(app.adding)return;
    app.adding=true;
    let list;
    try{
      $('#notice').hidden=true;
      const added=await unpackInputs(files);
      if(!added.length)throw Error('没有可提交的附件');
      const unique=new Map(app.files.map(f=>[attachmentPath(f),f]));
      for(const file of added)unique.set(attachmentPath(file),file);
      list=[...unique.values()];
    }finally{app.adding=false}
    app.files=list;
    app.key=makeKey();app.batch=null;
    await check();
  }
  async function check(start=false){
    if(app.busy)return;
    const seq=++fileSeq;
    if(!app.files.length){
      app.route=null;
      paintBatch();
      return;
    }
    app.route={message:'正在识别文件…'};
    paintBatch();
    try{
      const r=channelFor(app.files,app.data.channels,app.override);
      if(!r.code&&r.status==='waiting'&&!app.override){
        const legacy=await req('inspect',{method:'POST',body:{names:app.files.map(f=>f.name)}});
        if(legacy.code&&legacy.status==='ready')Object.assign(r,legacy);
      }
      if(seq!==fileSeq||disposed)return;
      app.route=r;
      if(r.status==='ready'&&start===true){
        app.busy=true;
        paintBatch();
        const code=r.code||app.files.map(f=>f.name.match(/^(\d+)[-_].*账单/)).find(Boolean)?.[1]||app.code;
        const channel=app.data.channels.find(c=>c.code===code);
        if(!channel)throw Error('未识别渠道，请先保存该渠道的提示词');
        const selection=app.selection?JSON.parse(app.selection):null;
        app.batch??={};
        const submitted=await submitToHarness({files:app.files,channel,urls:app.data.publicUrls||[],selection,batch:app.batch,uuid:makeKey});
        if(disposed)return;
        app.files=[];app.batch=null;
        app.route={status:'submitted',message:'已交给 Harness，请在左侧会话「'+submitted.title+'」查看执行进度和下载结果。'};
        paintJobs();
      }
    }catch(e){
      if(seq===fileSeq&&!disposed)app.route={...app.route,status:'conflict',retry:true,message:e.message};
    }
    finally{
      if(seq===fileSeq&&!disposed){
        app.busy=false;
        paintBatch();
      }
    }
  }
  function paintJobs(){
    const box=$('#jobs');
    if(!box)return;
    box.innerHTML=table(['账单 / 时间','渠道 / 账期','状态','核对结果','文件'],app.data.jobs.map(j=>{
      const s=j.stats;
      return ['<span class="stack"><b>'+esc(j.bill)+'</b><small>'+esc(fmtDate(j.created))+'</small></span>',esc(j.code+' / '+j.period),badge(({done:'已完成',running:'核对中',failed:'失败'})[j.state],j.state==='done'?'good':j.state==='failed'?'bad':'warn'),s?'共 '+s.total+' 笔　通过 '+s.passed+'　差异 '+s.different+'　待复核 '+s.review:esc(j.message),j.state==='done'?'<button type="button" class="link nowrap" data-dl="'+attr(j.id)+'" title="'+attr(j.filename)+'">下载 Excel</button>':'—'];
    }),'完成上传后，可以在这里查看进度和下载结果。');
    $all('[data-dl]').forEach(b=>b.onclick=guarded(async()=>{
      const job=app.data.jobs.find(j=>j.id===b.dataset.dl),res=await fetch('/api/freight/download?id='+encodeURIComponent(job.id));
      if(!res.ok)throw Error('结果下载失败，请刷新后重试。');
      const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');
      a.href=url;a.download=job.filename;root.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }));
  }
  let refreshing=false;
  async function refreshJobs(){
    if(refreshing)return;
    refreshing=true;
    try {
      const jobs=await req('jobs');
      if(!disposed){
        app.data.jobs=jobs;
        paintJobs();
      }
    }
    finally {
      refreshing=false;
    }
  }
  const timer=setInterval(()=>{
    if(app.data?.jobs.some(j=>j.state==='running'))guarded(refreshJobs)();
  },1200);
  async function start(){
    try { await sync(); }
    catch(error){
      if(disposed)return;
      root.querySelector('#page').innerHTML='<p>插件初始化失败</p>'+button('重新加载','retry');
      announce(error.message,true);
      root.querySelector('#retry').onclick=start;
    }
  }
  start();
  return ()=>{
    disposed=true;
    fileSeq++;
    loadSeq++;
    clearInterval(timer);
  };
}

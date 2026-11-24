export function native(React,mount,markup,css){
  const id='freight-reconciliation',h=React.createElement;
  function Panel({initial='run'}){
    const ref=React.useRef(null);
    React.useEffect(()=>{
      const host=ref.current,root=host.shadowRoot||host.attachShadow({mode:'open'});
      root.innerHTML='<style>'+css+'</style>'+markup;
      const stop=mount(root,initial);
      return ()=>{
        stop();root.replaceChildren();
      };
    },[initial]);
    return h('div',{ref,style:{display:'block',width:'100%',height:initial==='run'?'100%':'auto',overflow:'auto',minHeight:0,minWidth:0,flex:1},'data-freight-panel':initial});
  }
  function Icon(){
    return h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,'aria-hidden':true},h('path',{d:'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6'}));
  }
  return {inject:['slots'],apply(ctx){
    const slot=(name,extra,view)=>ctx.slots.inject(name,()=>ctx.slots.register({name,...extra},view));
    ctx.effect(function*(){
      yield slot('main',{key:id},()=>h(Panel));
      yield slot('sidebar.panellist',{id,order:20,label:'物流账单核对'},Icon);
      yield slot('plugins.bundle.config',{key:'dsh-freight-reconcile'},({view})=>view==='summary'?'物流账单核对规则':h(Panel,{initial:'channels'}));
    });
  }};
}

export class InputError extends Error {
  constructor(message,status=400){
    super(message);
    this.status=status;
  }
}

export function need(condition,message,status=400){
  if(!condition)throw new InputError(message,status);
}

export function text(value,label,limit,optional=false){
  const s=String(value??'').trim();
  need((optional||s.length)&&s.length<=limit,label+'为空或过长');
  return s;
}
function int(v,min,max,label){
  const n=Number(v);
  need(v!==''&&Number.isInteger(n)&&n>=min&&n<=max,label+'应为 '+min+'–'+max+' 的整数');
  return n;
}

export function httpURL(v){
  let u;
  try{
    u=new URL(v);
  }catch{
    throw new InputError('请输入完整的 HTTP(S) 地址');
  }
  need(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash,'请填写 HTTP(S) 地址，鉴权信息请单独配置');
  return u;
}

export function newProfile(code=''){
  return {code,name:code?'渠道 '+code:'',prompt:'按渠道、仓库和适用重量匹配有效报价，比较账单单价和报价单价。容差为 0。没有唯一报价时标记待复核。',billPattern:'{code}_账单_{period}.xlsx',quotePattern:'{code}_报价_*.xlsx',periodMode:'filename',fixedPeriod:'',minQuotes:1,billSheet:'',quoteSheet:'*',billHeader:1,quoteHeader:1,keyColumn:'运单号',resultPattern:'{bill}_核对结果.xlsx',outputMode:'full',requireApi:true};
}

export function validateProfile(v){
  const p={...newProfile(v.code),...v},code=text(p.code,'渠道编码',40);
  need(/^[A-Za-z0-9_-]+$/.test(code),'渠道编码只支持字母、数字、下划线和短横线');
  function mask(s){
    s=text(s,'文件名格式',900);
    for(const line of s.split(/\r?\n/).filter(l=>l.trim())){
      need(/\.xlsx$/i.test(line.trim())&&!/[\\/]/.test(line)&&!/[{}]/.test(line.replace(/\{(?:code|period|yyyy|mm|date)\}/g,'')),'请填写完整的 .xlsx 文件名规则或支持的占位符');
    }return s;
  }
  need(['filename','current','fixed'].includes(p.periodMode),'账期来源无效');
  const fixedPeriod=String(p.fixedPeriod||'').replace('-','');
  need(p.periodMode!=='fixed'||/^\d{4}(0[1-9]|1[0-2])$/.test(fixedPeriod),'请填写有效的固定账期 YYYYMM');
  const resultPattern=text(p.resultPattern,'结果文件名',120);
  need(/\.xlsx$/i.test(resultPattern)&&!/[\\/:*?"<>|\x00-\x1f]/u.test(resultPattern)&&!/[{}]/.test(resultPattern.replace(/\{(?:bill|code|period)\}/g,'')),'结果名称使用 .xlsx 后缀，可含 {bill}、{code}、{period}');
  need(['full','exceptions'].includes(p.outputMode),'请选择明细范围');
  return {code,name:text(p.name,'渠道名称',80),prompt:text(p.prompt,'提示词',20000),billPattern:mask(p.billPattern),quotePattern:mask(p.quotePattern),periodMode:p.periodMode,fixedPeriod,minQuotes:int(p.minQuotes,1,24,'所需报价份数'),billSheet:text(p.billSheet,'账单工作表',31,true),quoteSheet:text(p.quoteSheet,'报价工作表',120),billHeader:int(p.billHeader,1,999,'账单表头行'),quoteHeader:int(p.quoteHeader,1,999,'报价表头行'),keyColumn:text(p.keyColumn,'账单运单号列',120),resultPattern,outputMode:p.outputMode,requireApi:p.requireApi!==false};
}
export const defaultModel={baseUrl:'https://api.deepseek.com',model:'deepseek-flash',keyEnv:''};
const env=s=>{
  s=text(s,'环境变量名',100,true);
  need(!s||/^[A-Za-z_][A-Za-z0-9_]*$/.test(s),'环境变量名无效');
  return s;
};

export function modelConfig(v){
  const url=text(v.baseUrl,'模型地址',700);
  httpURL(url);
  return {baseUrl:url.replace(/\/+$/,''),model:text(v.model,'模型名称',100),keyEnv:env(v.keyEnv)};
}

export function apiConfig(v){
  const method=v.method||'GET',mode=v.mode||'batch',url=text(v.url,'接口地址',1800),body=text(v.body,'请求体',12000,true);
  need(['GET','POST'].includes(method)&&['batch','order'].includes(mode),'请求方式有误');
  httpURL(url.replace(/\{(?:code|period|waybill|page)\}/g,'test'));
  if(body){
    need(method==='POST','GET 请将参数放在地址中');
    try{
      JSON.parse(body);
    }catch{
      throw new InputError('POST 请求体须为 JSON');
    }
  }
  need(mode==='order'?(url+body).includes('{waybill}'):!(url+body).includes('{waybill}'),'逐单请求需要 {waybill}，批量请求按账期或渠道查询');
  for(const m of (url+' '+body).matchAll(/\{([A-Za-z_]\w*)\}/g))need(['code','period','waybill','page'].includes(m[1]),'未知请求占位符 '+m[0]);
  const authHeader=text(v.authHeader||'Authorization','鉴权头',80);
  need(/^[\w-]+$/.test(authHeader)&&!['host','connection','content-length','transfer-encoding','origin','cookie'].includes(authHeader.toLowerCase()),'鉴权头无效');
  need(Array.isArray(v.checks)&&v.checks.length>0&&v.checks.length<=20,'每个接口应配置 1–20 个比对字段');
  const checks=v.checks.map(c=>{
    need(['number','text'].includes(c.type),'字段类型无效');const tolerance=String(c.tolerance||'0');need(/^\d+(?:\.\d+)?$/.test(tolerance)&&tolerance.length<=40,'容差应为非负数');return {bill:text(c.bill,'账单字段',160),remote:text(c.remote,'接口字段',160),type:c.type,tolerance};
  });
  return {code:text(v.code,'所属渠道',40),name:text(v.name,'接口名称',80),url,body,mode,method,enabled:v.enabled!==false,authHeader,keyEnv:env(v.keyEnv),arrayPath:text(v.arrayPath,'记录路径',200,true),keyPath:text(v.keyPath,'运单号字段',200),successPath:text(v.successPath,'业务状态路径',200,true),successValue:text(v.successValue,'业务成功值',120,true),maxPages:int(v.maxPages??50,1,300,'分页上限'),checks};
}

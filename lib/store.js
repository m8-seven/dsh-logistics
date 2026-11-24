import {standardPrompt} from './uploaded.js';
import { DatabaseSync } from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {httpURL,defaultModel,newProfile,validateProfile,modelConfig,apiConfig,need,InputError} from './config.js';

export function visibleError(e){
  return e instanceof InputError?e.message:e?.name==='TimeoutError'?'请求超时，请检查连接':'处理失败，请检查工作簿及连接配置。';
}

export class Store{
  constructor(home){
    mkdirSync(home,{recursive:true,mode:0o700});
    const key=path.join(home,'credentials.key');
    try{
      writeFileSync(key,randomBytes(32),{flag:'wx',mode:0o600});
    }catch(e){
      if(e.code!=='EEXIST')throw e;
    }
    this.key=readFileSync(key);
    const dbFile=path.join(home,'freight.sqlite');
    this.db=new DatabaseSync(dbFile);
    chmodSync(dbFile,0o600);
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.exec('CREATE TABLE IF NOT EXISTS sys(id INTEGER PRIMARY KEY,value TEXT NOT NULL,secret TEXT,rev INTEGER NOT NULL DEFAULT 1);CREATE TABLE IF NOT EXISTS channels(code TEXT PRIMARY KEY,value TEXT NOT NULL,rev INTEGER NOT NULL DEFAULT 1);CREATE TABLE IF NOT EXISTS apis(id TEXT PRIMARY KEY,code TEXT NOT NULL REFERENCES channels(code) ON DELETE CASCADE,value TEXT NOT NULL,secret TEXT,rev INTEGER NOT NULL DEFAULT 1);CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,code TEXT,period TEXT,bill TEXT,created TEXT,state TEXT,message TEXT,stats TEXT,filename TEXT,result BLOB,owner_pid INTEGER)');
      if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='owner_pid'))this.db.exec('ALTER TABLE jobs ADD COLUMN owner_pid INTEGER');
      this.db.exec('CREATE TABLE IF NOT EXISTS freight_receipts(key TEXT PRIMARY KEY,digest TEXT NOT NULL,job TEXT NOT NULL REFERENCES jobs(id))');
      if(!this.db.prepare('SELECT id FROM sys WHERE id=1').get()){
        this.db.prepare('INSERT INTO sys(id,value) VALUES(1,?)').run(JSON.stringify(defaultModel));
        for(const code of ['1032','1035','1001'])this.db.prepare('INSERT INTO channels(code,value) VALUES(?,?)').run(code,JSON.stringify(newProfile(code)));
      }
      this.db.prepare('INSERT OR IGNORE INTO channels(code,value) VALUES(?,?)').run('fuxin',JSON.stringify({...newProfile('fuxin'),name:'福鑫八月账单',billPattern:'福鑫8月账单.xlsx',fixedPeriod:'202608',periodMode:'fixed',minQuotes:0,requireApi:false}));
      this.db.exec('CREATE TABLE IF NOT EXISTS public_urls(name TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE)');
      this.db.prepare('INSERT OR IGNORE INTO public_urls(name,url) VALUES(?,?)').run('allList','http://192.168.72.10:8080/jeecg-boot/logistics/logisticsInfo/allList');
      for(const code of ['1002','1032']){
        const preset={...newProfile(code),name:'渠道 '+code,prompt:standardPrompt,billPattern:'{code}-*月账单.xlsx\n{code}_账单_{period}.xlsx',quotePattern:'{code}-*年*月*日*.xlsx\n{code}_报价_*.xlsx',keyColumn:'客户单号'};
        this.db.prepare('INSERT OR IGNORE INTO channels(code,value) VALUES(?,?)').run(code,JSON.stringify(preset));
        this.db.prepare('UPDATE channels SET value=? WHERE code=? AND value=?').run(JSON.stringify(preset),code,JSON.stringify(newProfile(code)));
      }
      this.db.exec('COMMIT');
    }catch(e){
      this.db.exec('ROLLBACK');
      this.db.close();
      throw e;
    }
  }
  recover(){
    for(const r of this.db.prepare("SELECT id,owner_pid FROM jobs WHERE state='running'").all()){
      if(r.owner_pid){
        try{
          process.kill(r.owner_pid,0);
          continue;
        }catch(e){
          if(e.code!=='ESRCH')continue;
        }
      }
      this.fail(r.id,'上次执行已中断，请重传这一批文件。');
    }
  }
  secret(old,v){
    if(v.clearSecret===true)return null;
    if(!v.secret)return old?.secret||null;
    need(typeof v.secret==='string'&&v.secret.length<=6000&&!/[\r\n]/.test(v.secret),'密钥格式无效');
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv),data=Buffer.concat([c.update(v.secret,'utf8'),c.final()]);
    return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');
  }
  view(row,priv=false){
    if(!row)return null;
    const v={...(row.code&&!('id' in row)?newProfile(row.code):{}),...JSON.parse(row.value),rev:row.rev};
    if(typeof row.id==='string')v.id=row.id;
    if('secret' in row){
      v.hasSecret=Boolean(row.secret);
      if(priv){
        if(!row.secret)v.token=v.keyEnv?process.env[v.keyEnv]||'':'';
        else{
          const b=Buffer.from(row.secret,'base64'),c=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));
          c.setAuthTag(b.subarray(12,28));
          v.token=Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');
        }
      }
    }
    return v;
  }
  publicUrls(){return this.db.prepare('SELECT name,url FROM public_urls ORDER BY name').all()}
  saveUrl(v){
    const name=String(v.name||'').trim(),url=String(v.url||'').trim();need(name&&name.length<=80,'请填写接口名称');httpURL(url);
    this.db.prepare('INSERT INTO public_urls(name,url) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET url=excluded.url').run(name,url);
    return {ok:true};
  }
  channels(){
    return this.db.prepare('SELECT * FROM channels ORDER BY code').all().map(r=>this.view(r));
  }
  channel(code){
    const p=this.view(this.db.prepare('SELECT * FROM channels WHERE code=?').get(code));
    need(p,'渠道不存在',404);
    return p;
  }
  apis(code,priv=false){
    return this.db.prepare('SELECT * FROM apis WHERE code=? ORDER BY rowid').all(code).map(r=>this.view(r,priv));
  }
  model(priv=false){
    return this.view(this.db.prepare('SELECT * FROM sys WHERE id=1').get(),priv);
  }
  changed(op){
    need(op.changes===1,'配置已被其他窗口修改，请刷新后重试',409);
  }
  saveChannel(v,code){
    const p=validateProfile(v);
    if(code===undefined){
      need(!this.db.prepare('SELECT code FROM channels WHERE code=?').get(p.code),'渠道编码已存在',409);
      this.db.prepare('INSERT INTO channels(code,value) VALUES(?,?)').run(p.code,JSON.stringify(p));
    }
    else{
      need(code===p.code,'请保留原渠道编码');
      this.changed(this.db.prepare('UPDATE channels SET value=?,rev=rev+1 WHERE code=? AND rev=?').run(JSON.stringify(p),code,v.rev));
    }return this.channel(p.code);
  }
  saveApi(v,id){
    const p=apiConfig(v);
    this.channel(p.code);
    const old=id?this.db.prepare('SELECT * FROM apis WHERE id=?').get(id):null;
    need(!id||old,'接口不存在',404);
    const secret=this.secret(old,v);
    if(id){
      need(old.code===p.code,'请保留接口所属渠道');
      this.changed(this.db.prepare('UPDATE apis SET value=?,secret=?,rev=rev+1 WHERE id=? AND rev=?').run(JSON.stringify(p),secret,id,v.rev??0));
    }
    else{
      id=randomUUID();
      this.db.prepare('INSERT INTO apis(id,code,value,secret) VALUES(?,?,?,?)').run(id,p.code,JSON.stringify(p),secret);
    }return this.view(this.db.prepare('SELECT * FROM apis WHERE id=?').get(id));
  }
  saveModel(v){
    const p=modelConfig(v),old=this.db.prepare('SELECT * FROM sys WHERE id=1').get();
    this.changed(this.db.prepare('UPDATE sys SET value=?,secret=?,rev=rev+1 WHERE id=1 AND rev=?').run(JSON.stringify(p),this.secret(old,v),v.rev??0));
    return this.model();
  }
  remove(type,id,rev){
    this.changed(this.db.prepare(type==='channel'?'DELETE FROM channels WHERE code=? AND rev=?':'DELETE FROM apis WHERE id=? AND rev=?').run(id,Number(rev)||0));
  }
  newJob(code,period,bill){
    const id=randomUUID();
    this.db.prepare("INSERT INTO jobs(id,code,period,bill,created,state,message,owner_pid) VALUES(?,?,?,?,?,'running','正在读取 Excel',?)").run(id,code,period,bill,new Date().toISOString(),process.pid);
    return id;
  }
  progress(id,s){
    this.db.prepare('UPDATE jobs SET message=? WHERE id=?').run(s,id);
  }
  fail(id,s){
    this.db.prepare("UPDATE jobs SET state='failed',message=? WHERE id=?").run(s,id);
  }
  complete(id,filename,stats,bytes){
    this.db.prepare("UPDATE jobs SET state='done',message='核对完成',filename=?,stats=?,result=? WHERE id=?").run(filename,JSON.stringify(stats),bytes,id);
  }
  jobs(id){
    const sql='SELECT id,code,period,bill,created,state,message,filename,stats FROM jobs',unpack=r=>({...r,stats:r.stats?JSON.parse(r.stats):null});
    if(id){
      const r=this.db.prepare(sql+' WHERE id=?').get(id);
      need(r,'核对记录不存在',404);
      return unpack(r);
    }return this.db.prepare(sql+' ORDER BY created DESC LIMIT 100').all().map(unpack);
  }
  download(id){
    const d=this.db.prepare("SELECT filename,result FROM jobs WHERE id=? AND state='done'").get(id);
    need(d,'结果尚未生成',404);
    return d;
  }
  close(){
    this.db.close();
  }
}

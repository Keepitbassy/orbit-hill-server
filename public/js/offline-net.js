// Browser-only transport with the same event interface as Net.
export class OfflineNet {
 constructor({onChange}={}){this.handlers=new Map();this.connected=false;this.onChange=onChange||(()=>{});this.stats={sent:0,received:0,bytes:0};this.ping=0;this.worker=null;}
 on(type,fn){if(!this.handlers.has(type))this.handlers.set(type,new Set());this.handlers.get(type).add(fn);return()=>this.handlers.get(type)?.delete(fn)}
 emit(type,data){for(const fn of this.handlers.get(type)||[])try{fn(data)}catch(err){console.error(err)}}
 connect(){if(this.worker)return;this.worker=new Worker('/js/offline-worker.js',{type:'module'});
 this.worker.onmessage=({data})=>{this.stats.received++;this.emit(data.t,data);this.emit('*',data)};
 this.worker.onerror=(err)=>{console.error(err);this.emit('error',{message:'No se pudo iniciar el motor offline.'})};
 this.connected=true;queueMicrotask(()=>{this.emit('open');this.onChange()});}
 send(obj){if(!this.worker)return false;this.stats.sent++;this.worker.postMessage(obj);return true}
 close(){this.worker?.terminate();this.worker=null;this.connected=false;this.emit('closed',{manual:true});this.onChange()}
}

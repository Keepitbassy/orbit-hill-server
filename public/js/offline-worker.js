// Runs the original Orbit Hill match simulation entirely on-device.
import { Room, listBattlefields } from '/server/room.js';
import { DT, TICK_RATE, TEAM_SIZE, MAX_HUMANS_PER_ROOM, SCORE_TO_WIN, MATCH_SECONDS, MODE_LABEL, HILL_SECONDS_OPTIONS, HILL_SECONDS_DEFAULT, BATTLEFIELD_DEFAULT } from '/shared/constants.js';
import { sanitizeName, modeInfo, listModes, listArenas } from '/shared/rules.js';
let room = null;
const client = {playerId:'offline-pilot',name:'Piloto',team:null,slot:null,roomCode:null,rematchVote:false,
  send(obj){postMessage(obj)}, sendRaw(raw){postMessage(JSON.parse(raw))}};
function welcome(){
 const info=modeInfo(room.mode);
 postMessage({t:'welcome',id:client.playerId,name:client.name,code:room.code,team:client.team,host:room.hostId,
 mode:room.mode,modeLabel:MODE_LABEL[room.mode],objective:info.objective,teamBased:info.teamBased,
 modes:listModes(),maxPerTeam:info.teamBased?TEAM_SIZE:0,maxHumans:MAX_HUMANS_PER_ROOM,
 scoreToWin:SCORE_TO_WIN,matchSeconds:MATCH_SECONDS,target:info.target,tactical:room.tacticalActive,
 settings:room.settingsPayload(),world:room.worldPayload(),hill:room.match.hillPayload(),
 arenas:listArenas(),hillSecondsOptions:[...HILL_SECONDS_OPTIONS],hillSecondsDefault:HILL_SECONDS_DEFAULT,
 battlefield:room.battlefield,battlefieldDefault:BATTLEFIELD_DEFAULT,battlefields:listBattlefields(),
 pads:room.match.pads.map(p=>({id:p.id,x:p.x,y:p.y,type:p.type})),tickRate:TICK_RATE});
 room.broadcastRoster();
}
onmessage=({data:msg})=>{
 try {
 if(msg.t==='ping'){postMessage({t:'pong',ts:msg.ts});return}
 if(msg.t==='create'||msg.t==='join'){
  room=new Room('SOLO',{mode:msg.t==='create'?msg.mode||'ffa':'ffa',settings:{arena:msg.arena,hillSeconds:msg.hillSeconds,stocks:msg.stocks,battlefield:msg.battlefield||BATTLEFIELD_DEFAULT}});
  client.name=sanitizeName(msg.name)||'Piloto';
  const added=room.addClient(client,{name:client.name,team:msg.team});
  if(!added.ok)throw Error(added.reason);
  welcome();return;
 }
 if(msg.t==='name'){client.name=sanitizeName(msg.name)||client.name;const p=room?.match.getPlayer(client.playerId);if(p)p.name=client.name;room?.broadcastRoster();return}
 if(!room){postMessage({t:'error',message:'Crea una partida individual primero.'});return}
 room.handleMessage(client,msg);
 }catch(err){postMessage({t:'error',message:String(err?.message||err)})}
};
setInterval(()=>{if(room)try{room.tick(DT)}catch(err){postMessage({t:'error',message:'Error de simulación: '+err.message});room=null}},1000/TICK_RATE);

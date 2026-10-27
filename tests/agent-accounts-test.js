/**
 * Integration test for helper/agentAccounts.js + routes/agentAccounts.js.
 * Needs an EMPTY test database with the minimal tables below, never production:
 *   user, agents, instance, meta_api, messenger_accounts, instagram_accounts,
 *   telegram_session, agent_instances, beta_chats
 * Edit the env lines and APP path, then: node tests/agent-accounts-test.js
 */
process.env.DBUSER="t";process.env.DBPASS="t";process.env.DBNAME="crmtest";process.env.JWTKEY="k";
const APP="/home/user/call-center/extract_to _server";
const path=require("path"); const { query } = require(path.join(APP,"database/dbpromise"));
const H=require(path.join(APP,"helper/agentInstances")); const A=require(path.join(APP,"helper/agentAccounts"));
const express=require("express"); const jwt=require("jsonwebtoken");
let pass=0,fail=0; const check=(l,c,x)=>{c?pass++:fail++; console.log((c?"  PASS ":"  FAIL ")+l+(c?"":"  -> "+JSON.stringify(x)));};
const O="OWNER1", O2="OWNER2";
async function seed(){
  await query(`INSERT INTO user (uid,role) VALUES (?,?),(?,?)`,[O,"user",O2,"user"]);
  await query(`INSERT INTO agents (id,uid,owner_uid,name,email) VALUES (5,'AG_A',?,'A','a@x'),(6,'AG_B',?,'B','b@x'),(7,'AG_C',?,'C','c@x')`,[O,O,O2]);
  await query(`INSERT INTO instance (uid,uniqueId,title,number,status) VALUES (?,?,?,?,?)`,[O,"INS1","Sales","201094646331","CONNECTED"]);
  await query(`INSERT INTO meta_api (uid,business_phone_number_id) VALUES (?,?)`,[O,"555"]);
  await query(`INSERT INTO messenger_accounts (uid,page_id,page_name) VALUES (?,?,?),(?,?,?),(?,?,?)`,[O,"111","Page X",O,"222","Page Y",O2,"999","Other tenant page"]);
  await query(`INSERT INTO instagram_accounts (uid,user_id,webhook_id,username,name) VALUES (?,?,?,?,?)`,[O,"17841","W1","shopig","Shop"]);
  await query(`INSERT INTO telegram_session (uid,session_id) VALUES (?,?)`,[O,"S1"]);
  const chats=[
    ["c_qr","qr",JSON.stringify({id:"201094646331:63@s.whatsapp.net"})],
    ["c_meta","meta",JSON.stringify({id:"+20 100"})],
    ["c_px","messenger",JSON.stringify({id:"111",name:"Page X"})],
    ["c_py","messenger",JSON.stringify({id:"222",name:"Page Y"})],
    ["c_ig","instagram",JSON.stringify({id:"17841",username:"shopig"})],
    ["c_ig_num","instagram",JSON.stringify({id:17841})],
    ["c_igc","instagram_comment",JSON.stringify({id:"17841"})],
    ["c_tg","telegram",JSON.stringify({id:"777"})],
    ["c_px2_prefix","messenger",JSON.stringify({id:"1112"})],
  ];
  for(const [c,o,i] of chats) await query(`INSERT INTO beta_chats (uid,chat_id,origin,origin_instance_id) VALUES (?,?,?,?)`,[O,c,o,i]);
  await query(`INSERT INTO beta_chats (uid,chat_id,origin,origin_instance_id,assigned_agent) VALUES (?,?,?,?,?)`,[O,"c_manual","messenger",JSON.stringify({id:"333"}),JSON.stringify([{id:5,uid:"AG_A"}])]);
}
async function visible(agentId,agentUid,extra){
  const s=await H.buildAgentChatCondition(agentId,agentUid);
  let sql=`SELECT chat_id FROM beta_chats WHERE uid = ? AND ${s.sql}`; const p=[O,...s.params];
  if(extra){sql+=` AND ${extra.sql}`;p.push(...extra.params);}
  return (await query(sql,p)).map(r=>r.chat_id).sort();
}
(async()=>{
  await seed();
  check("stock: agent sees only manually assigned chat", JSON.stringify(await visible(5,"AG_A"))==='["c_manual"]', await visible(5,"AG_A"));

  const app=express(); app.use(express.json()); app.use("/api/agent_accounts",require(path.join(APP,"routes/agentAccounts")));
  const srv=app.listen(0); const base=`http://127.0.0.1:${srv.address().port}/api/agent_accounts`;
  const tok=(p)=>jwt.sign(p,"k"); const OT=tok({uid:O,role:"user",tokenVersion:0}), AT=tok({uid:"AG_A",role:"agent",owner_uid:O}), BT=tok({uid:"AG_B",role:"agent",owner_uid:O});
  const call=(t,m,u,b)=>fetch(base+u,{method:m,headers:{"Content-Type":"application/json",Authorization:"Bearer "+t},body:b?JSON.stringify(b):undefined}).then(r=>r.json());

  const ov=await call(OT,"GET","/overview");
  const keys=ov.data.accounts.map(a=>a.key);
  check("overview lists all channels", JSON.stringify(keys.sort())===JSON.stringify(["instagram:17841","messenger:111","messenger:222","meta:all","qr:201094646331","telegram:all"]), keys);
  check("overview excludes other tenant page", !keys.includes("messenger:999"));

  const set=await call(OT,"POST","/set",{agent_uid:"AG_A",accounts:["messenger:111","instagram:17841","qr:201094646331","messenger:999","bogus"]});
  check("set keeps only owned keys", set.success && set.data.accounts.length===3, set);
  check("qr stored in agent_instances", (await query(`SELECT * FROM agent_instances WHERE agent_uid='AG_A'`)).length===1);

  const vA=await visible(5,"AG_A");
  check("agent A sees Page X, IG (all forms), QR, manual", JSON.stringify(vA)==='["c_ig","c_ig_num","c_igc","c_manual","c_px","c_qr"]', vA);
  check("Page id prefix does not leak (1112)", !vA.includes("c_px2_prefix"));
  const vB=await visible(6,"AG_B");
  check("agent B unaffected", vB.length===0, vB);

  await call(OT,"POST","/set",{agent_uid:"AG_B",accounts:["meta:all","telegram:all","messenger:222"]});
  const vB2=await visible(6,"AG_B");
  check("agent B sees meta, telegram, Page Y", JSON.stringify(vB2)==='["c_meta","c_py","c_tg"]', vB2);

  const otherTenant=await call(OT,"POST","/set",{agent_uid:"AG_C",accounts:["messenger:111"]});
  check("cannot assign another tenant's agent", !otherTenant.success);

  // filter
  const fA=await call(AT,"GET","/filter");
  check("agent filter options = assigned only", fA.data.options.length===3 && fA.data.current==="", fA);
  const bad=await call(AT,"POST","/filter",{account:"messenger:222"});
  check("agent cannot filter by unassigned account", !bad.success);
  await call(AT,"POST","/filter",{account:"messenger:111"});
  const cond=await A.buildInboxFilterCondition("AG_A");
  const vf=await visible(5,"AG_A",cond);
  check("agent filtered to Page X only", JSON.stringify(vf)==='["c_px"]', vf);
  await call(AT,"POST","/filter",{account:""});
  check("clearing filter", (await A.buildInboxFilterCondition("AG_A"))===null);

  const fO=await call(OT,"GET","/filter");
  check("owner filter sees all 6", fO.data.options.length===6);
  await call(OT,"POST","/filter",{account:"instagram:17841"});
  const oc=await A.buildInboxFilterCondition(O);
  const ov2=(await query(`SELECT chat_id FROM beta_chats WHERE uid=? AND ${oc.sql} `,[O,...oc.params])).map(r=>r.chat_id).sort();
  check("owner filter to IG", JSON.stringify(ov2)==='["c_ig","c_ig_num","c_igc"]', ov2);

  const ag=await H.getAgentsForChat({ownerUid:O,chatId:"c_px"});
  check("notification targets for Page X chat = A", ag.map(a=>a.uid).join()==="AG_A", ag);
  const ag2=await H.getAgentsForChat({ownerUid:O,chatId:"c_tg"});
  check("notification targets for telegram = B", ag2.map(a=>a.uid).join()==="AG_B", ag2);

  const noTok=await fetch(base+"/filter").then(r=>r.json());
  check("filter requires token", !noTok.success);

  console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});

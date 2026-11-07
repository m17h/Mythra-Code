//! Typed child sign-off and cutoff, never untagged renderer Stop callbacks.
use super::{commit::{self,Stamp,StateWrite},store,work,RemoteState};
use rusqlite::{Connection,OptionalExtension};
use serde_json::{json,Value};
use tauri::{AppHandle,State,WebviewWindow};
fn stale()->String{work::refused("stale_target")}
fn uncertain_cutoff()->String{"MYTHRA_DELIVERY_UNCERTAIN: The stop request was sent, but this device could not confirm the sub-agent stopped. Check it here before replacing it.".into()}
fn object(v:&Value)->Result<serde_json::Map<String,Value>,String>{if v.is_null(){Ok(Default::default())}else{v.as_object().cloned().ok_or_else(stale)}}
fn same_path(a:&str,b:&str)->bool{match(std::fs::canonicalize(a),std::fs::canonicalize(b)){(Ok(a),Ok(b))=>a==b,_=>false}}
fn link(db:&Connection,stamp:&Stamp,child:&str)->Result<Value,String>{
 let links=commit::state_row(db,"kiwi.childAgentLinks")?;let link=links["value"].get(child).filter(|l|l["childThreadId"]==child&&l["rootThreadId"].as_str()==stamp.thread_id.as_deref()).ok_or_else(stale)?;Ok(link.clone())
}
fn stop_link(db:&Connection,stamp:&Stamp,child:&str,target:&work::Target)->Result<(Value,Option<Value>),String>{
 let managed=commit::state_row(db,"kiwi.childAgentLinks")?;if managed["value"].get(child).is_some(){return Ok((link(db,stamp,child)?,None));}
 let native=commit::state_row(db,"kiwi.nativeAgentLinks")?;let native=native["value"].get(child).filter(|l|l["childThreadId"]==child&&l["rootThreadId"].as_str()==stamp.thread_id.as_deref()).ok_or_else(stale)?;
 if native["runtime"]=="claude"||child.starts_with("claude-native:"){return Err(work::refused("unsupported"));}
 if native["runtime"].as_str().is_some_and(|v|v!="codex")||!matches!(target.provider.as_deref(),Some("openai"|"openrouter"|"lmstudio")){return Err(stale());}
 let activation=native["activationId"].as_str().filter(|s|!s.is_empty()).ok_or_else(stale)?;let alias=native["activationAliasId"].as_str();
 Ok((native.clone(),Some(json!({"parent":stamp.thread_id,"child":child,"activation":activation,"alias":alias,"runtimeOwner":target.owner}))))
}
fn binding(db:&Connection,stamp:&Stamp,link:&Value)->Result<(String,String),String>{
 let provider=link["provider"].as_str().filter(|p|matches!(*p,"openai"|"openrouter"|"lmstudio"|"claude"|"cursor")).ok_or_else(stale)?.to_owned();let child=link["childThreadId"].as_str().ok_or_else(stale)?;
 let projects=commit::state_row(db,"kiwi.projects")?;let workspace=stamp.workspace_id.as_deref().ok_or_else(stale)?;
 let project=projects["value"].as_array().and_then(|p|p.iter().find(|p|p["id"]==workspace));
 let paths=commit::state_row(db,"kiwi.threadProjects")?;let known=commit::state_row(db,"kiwi.knownThreads")?;let trees=commit::state_row(db,"kiwi.threadWorktrees")?;
 let assigned=paths["value"].get(child).and_then(Value::as_str).or_else(||known["value"].get(child).and_then(|r|r["cwd"].as_str())).ok_or_else(stale)?;let tree=trees["value"].get(child).filter(|r|r["status"]!="removed");
 let root=link["executionPath"].as_str().or_else(||tree.and_then(|r|r["path"].as_str())).unwrap_or(assigned);let base=if workspace=="openkiwi-normal-chats"{assigned}else{project.and_then(|p|p["path"].as_str()).ok_or_else(stale)?};
 if !same_path(assigned,base)&&!tree.is_some_and(|r|r["projectId"]==workspace&&r["projectPath"].as_str().is_some_and(|p|same_path(p,base))){return Err(stale());}
 if !same_path(root,assigned)&&!trees["value"].as_object().is_some_and(|rows|rows.values().any(|r|r["status"]!="removed"&&r["projectId"]==workspace&&r["path"].as_str().is_some_and(|p|same_path(p,root)))){return Err(stale());}Ok((provider,root.to_owned()))
}
fn validate_accept(db:&Connection,stamp:&Stamp,writes:&[StateWrite])->Result<(String,Value,String,String),String>{
 if writes.len()!=2{return Err(stale());}let links=writes.iter().find(|w|w.key=="kiwi.childAgentLinks").ok_or_else(stale)?;let mail=writes.iter().find(|w|w.key=="kiwi.childAgentMailbox").ok_or_else(stale)?;
 let saved=commit::state_row(db,&links.key)?;let old=object(&saved["value"])?;let mut next=object(&links.value)?;
 let changed=next.iter().filter(|(id,l)|old.get(*id)!=Some(*l)).map(|(id,_)|id.clone()).collect::<Vec<_>>();if changed.len()!=1||next.len()!=old.len(){return Err(stale());}let child=&changed[0];let before=link(db,stamp,child)?;let after=next.get(child).cloned().ok_or_else(stale)?;
 if before["signoff"]!="required"||before["acceptedAt"].as_i64().is_some()||before["activationPending"]==true||!matches!(before["terminalStatus"].as_str(),Some("completed"|"cancelled"|"failed"))||before["finishedAt"].as_i64().is_none(){return Err(stale());}
 if !after["acceptedAt"].as_i64().is_some_and(|t|t>0)||after["acceptedBy"]!="user"||after.get("acceptNote").is_some_and(|s|!s.as_str().is_some_and(|s|s.chars().count()<=400)){return Err(stale());}
 let mut reduced=after.clone();let mut old_reduced=before.clone();for k in ["acceptedAt","acceptedBy","acceptNote"]{reduced.as_object_mut().ok_or_else(stale)?.remove(k);old_reduced.as_object_mut().ok_or_else(stale)?.remove(k);}if reduced!=old_reduced{return Err(stale());}next.insert(child.clone(),before.clone());if next!=old{return Err(stale());}
 let old_mail=object(&commit::state_row(db,&mail.key)?["value"])?;let mut new_mail=object(&mail.value)?;let box_before=old_mail.get(child).cloned().unwrap_or(Value::Null);let box_after=new_mail.remove(child).unwrap_or(Value::Null);let mut other_mail=old_mail.clone();other_mail.remove(child);if new_mail!=other_mail{return Err(stale());}
 if !box_before.is_null(){if box_before["rootThreadId"].as_str()!=stamp.thread_id.as_deref()||box_before["messages"].as_array().is_none_or(|a|a.iter().any(|m|m["direction"]=="toChild"&&m["state"]=="delivering")){return Err(stale());}if accepted_mailbox(&box_before,after["acceptedAt"].as_i64().ok_or_else(stale)?)?!=box_after{return Err(stale());}}else if !box_after.is_null(){return Err(stale());}
 let(provider,root)=binding(db,stamp,&before)?;
 if matches!(provider.as_str(),"claude"|"cursor"){let text:String=db.query_row("SELECT thread_json FROM local_transcript_meta WHERE provider=?1 AND thread_id=?2",rusqlite::params![provider,child],|r|r.get(0)).map_err(|_|stale())?;let actual:Value=serde_json::from_str(&text).map_err(|_|stale())?;if actual["id"]!=*child||!actual["cwd"].as_str().is_some_and(|p|same_path(p,&root)){return Err(stale());}}
 Ok((child.clone(),before,provider,root))
}
fn accepted_mailbox(before:&Value,now:i64)->Result<Value,String>{
 let mut out=before.clone();let messages=out["messages"].as_array_mut().ok_or_else(stale)?;let mut through=before["undeliveredSeq"].as_u64().unwrap_or(0).max(before["resolvedThroughSeq"].as_u64().unwrap_or(0));
 for msg in messages{let seq=msg["id"].as_str().and_then(|s|s.strip_prefix('m')).and_then(|s|s.parse::<u64>().ok()).unwrap_or(0);if msg["direction"]=="toChild"&&matches!(msg["state"].as_str(),Some("failed"|"cancelled"|"queued")){through=through.max(seq);}if msg["direction"]=="toChild"&&msg["state"]=="queued"{msg["state"]=json!("cancelled");msg["settledAt"]=json!(now);msg["reason"]=json!("Cancelled because the user accepted the sub-agent's work.");}if msg["direction"]=="toParent"&&msg["kind"]=="question"&&msg.get("answeredAt").is_none_or(Value::is_null)&&msg.get("closedAt").is_none_or(Value::is_null){msg["closedAt"]=json!(now);}}
 out["undeliveredSeq"]=json!(through);out["resolvedThroughSeq"]=json!(through);Ok(out)
}
pub(super) struct Acceptance{child:String,link:Value,provider:String,proof:Option<crate::RemoteThreadProviderProof>}
impl Acceptance{
 pub(super) async fn prepare(app:&AppHandle,state:&RemoteState,stamp:&Stamp,writes:&[StateWrite])->Result<Self,String>{
  let s=stamp.clone();let ws=writes.to_vec();let inner=state.inner.clone();let(child,link,provider,root)=state.inner.read_db(move|db|{s.check(&inner.lock(),"agents.accept")?;validate_accept(db,&s,&ws)}).await?;
  if stamp.workspace_id.as_deref()==Some("openkiwi-normal-chats")&&!crate::normal_chat::contains(app,&root)?{return Err(stale());}
  let proof=if matches!(provider.as_str(),"claude"|"cursor"){None}else{Some(crate::remote_thread_provider_proof(app,&provider,&child,&root,"agents.accept",None).await?)};Ok(Self{child,link,provider,proof})
 }
 pub(super) fn gate<T>(&self,app:&AppHandle,commit:impl FnOnce()->Result<T,String>)->Result<T,String>{if let Some(proof)=&self.proof{proof.idle_metadata_gate(commit)}else{crate::remote_local_thread_gate(app,&self.provider,&self.child,"agents.accept",commit)}}
 pub(super) fn busy(&self,core:&super::Core)->bool{super::owners::thread_busy(core,&self.child)}
 pub(super) fn validate(&self,db:&Connection,stamp:&Stamp,writes:&[StateWrite])->Result<(),String>{let(child,link,_,_)=validate_accept(db,stamp,writes)?;if child!=self.child||link!=self.link{return Err(stale());}Ok(())}
}
/// Host resolves its resource to an actual native owner, never a viewer path.
#[tauri::command]
pub(crate) async fn remote_agent_stop(app:AppHandle,state:State<'_,RemoteState>,window:WebviewWindow,stamp:Stamp,child_thread_id:String,target_handle:String)->Result<Value,String>{
 super::hostbridge::window_is_host(&window).map_err(|_|stale())?;
 let s=stamp.clone();let child=child_thread_id.clone();let h=target_handle.clone();let inner=state.inner.clone();
 let sub=super::finish_write(state.inner.enqueue_write(false,move|db|{let tx=db.transaction().map_err(|_|stale())?;let core=inner.lock();let op=commit::operation(&tx,&s)?;if !matches!(op.as_str(),"agents.stop"|"agents.replace"){return Err(stale());}s.check(&core,&op)?;
  let existing:Option<(String,String)>=tx.query_row("SELECT op_id,delivery_json FROM remote_op_journal WHERE device_fingerprint=?1 AND engine_root=?2 AND engine_step='agent-cutoff'",rusqlite::params![s.device,s.op_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|stale())?;
  if let Some((id,r))=existing{let r:Value=serde_json::from_str(&r).map_err(|_|stale())?;if r["threadId"]!=child{return Err(stale());}return Ok(Stamp{op_id:id,op_seq:1,thread_id:Some(child),..s.clone()});}
  let target=work::target_locked(&core,&s.meta(),&h)?;let(link,proof)=stop_link(&tx,&s,&child,&target)?;if target.thread_id.as_deref()!=Some(&child)||target.workspace_id!=s.workspace_id||!matches!(target.kind.as_str(),"turn"|"start"|"parent"){return Err(stale());}
  if link["activationTurnId"].as_str().is_some_and(|id|target.turn_id.as_deref()!=Some(id))||link["activationPending"]==true&&link["activationStartRequestId"].as_str().is_some_and(|id|target.start_request_id.as_deref()!=Some(id)){return Err(stale());}
  let sub=super::instructions::child(&tx,&s,"agent-cutoff","turn.stop",Some(&child),&json!({"target":h,"link":link}))?;
  {let mut r=store::delivery_receipt(&tx,&sub.device,&sub.op_id,sub.op_seq)?.ok_or_else(stale)?;r["stopTarget"]=serde_json::to_value(&target).map_err(|_|stale())?;r["stopTargetOwner"]=json!(target.owner);tx.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![sub.device,sub.op_id,sub.op_seq as i64,r.to_string()]).map_err(|_|stale())?;}
  if let Some(proof)=proof{let mut r=store::delivery_receipt(&tx,&sub.device,&sub.op_id,sub.op_seq)?.ok_or_else(stale)?;r["agentStopProof"]=proof;tx.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![sub.device,sub.op_id,sub.op_seq as i64,r.to_string()]).map_err(|_|stale())?;}
  tx.commit().map_err(|_|stale())?;Ok(sub)})).await?;
 let copy=sub.clone();let done=state.inner.read_db(move|db|Ok(store::delivery_receipt(db,&copy.device,&copy.op_id,copy.op_seq)?.is_some_and(|r|r["disposition"]=="accepted"))).await?;
 if !done{let result=work::remote_work_dispatch(app.clone(),state.clone(),window,sub.generation,sub.device.clone(),sub.op_id.clone(),sub.op_seq,None,None,"turn_stop".into(),json!({"threadId":child_thread_id}),Some(target_handle),None).await?;if result["confirmed"]!=true{return Err(work::refused("uncertain"));}}
 let copy=sub.clone();let saved=state.inner.read_db(move|db|store::delivery_receipt(db,&copy.device,&copy.op_id,copy.op_seq)).await?.ok_or_else(stale)?;
 let mut stopped:work::Target=serde_json::from_value(saved["stopTarget"].clone()).map_err(|_|uncertain_cutoff())?;stopped.owner=saved["stopTargetOwner"].as_str().ok_or_else(uncertain_cutoff)?.to_owned();
 // A journalled input ACK is NOT proof that its exact child stopped. Never send
 // a second interrupt to "confirm" it; duplicates join this native end wait.
 if !(stopped.owner_handle.is_some()&&stopped.kind=="parent"){
  tokio::time::timeout(std::time::Duration::from_secs(12),async{loop{if crate::remote_owned_child_ended(&app,&mut stopped).await.map_err(|_|uncertain_cutoff())?{return Ok::<_,String>(());}tokio::time::sleep(std::time::Duration::from_millis(40)).await;}}).await.map_err(|_|uncertain_cutoff())??;
 }
 let cutoff_proof=saved.get("agentStopProof").cloned();let worker=state.inner.clone();super::finish_write(state.inner.enqueue_write(false,move|db|{let mut apply=||{let tx=db.transaction().map_err(|_|stale())?;let core=worker.lock();let op=commit::operation(&tx,&stamp)?;stamp.check(&core,&op)?;let accepted=store::delivery_receipt(&tx,&sub.device,&sub.op_id,sub.op_seq)?.ok_or_else(stale)?;if accepted["disposition"]!="accepted"{return Err(stale());}
  let mut receipt=store::delivery_receipt(&tx,&stamp.device,&stamp.op_id,stamp.op_seq)?.ok_or_else(stale)?;receipt["agentCutoffConfirmed"]=json!(child_thread_id);if let Some(proof)=&cutoff_proof{receipt["agentCutoffProof"]=proof.clone();}tx.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![stamp.device,stamp.op_id,stamp.op_seq as i64,receipt.to_string()]).map_err(|_|stale())?;
  if op=="agents.stop"{commit::complete(&tx,&stamp,&op,&json!({"opId":stamp.op_id,"state":"accepted","confirmed":true,"threadId":stamp.thread_id}),false)?;}tx.commit().map_err(|_|stale())?;Ok(json!({"confirmed":true}))};if let Some(proof)=&cutoff_proof{crate::remote_agent_cutoff_gate(&app,proof,apply).map_err(|_|uncertain_cutoff())}else{apply()}})).await
}
#[cfg(test)]
mod tests{
 use super::*;
 fn prepare_fixture()->(super::super::threads::tests::Fixture,Vec<StateWrite>){
  let f=super::super::threads::tests::fixture("agents.accept");let child=json!({"id":"child","cwd":f.path,"modelProvider":"claude"});commit::write_value(&f.db,"kiwi.knownThreads",&json!({"t":{"id":"t","cwd":f.path},"child":child})).unwrap();commit::write_value(&f.db,"kiwi.threadProjects",&json!({"t":f.path,"child":f.path})).unwrap();f.db.execute("INSERT INTO local_transcript_meta VALUES('claude','child',?1,1)",[child.to_string()]).unwrap();
  let link=json!({"rootThreadId":"t","childThreadId":"child","provider":"claude","sessionId":"s","createdAt":1,"signoff":"required","activationId":"a","activationTurnId":"turn","terminalStatus":"completed","finishedAt":10});let links=json!({"child":link,"other":{"childThreadId":"other"}});let mail=json!({"child":{"rootThreadId":"t","messages":[{"id":"m1","direction":"toChild","state":"queued","text":"guidance"},{"id":"m2","direction":"toParent","kind":"question","text":"question"}]},"other":{"messages":[]}});
  commit::write_value(&f.db,"kiwi.childAgentLinks",&links).unwrap();commit::write_value(&f.db,"kiwi.childAgentMailbox",&mail).unwrap();let mut next=links.clone();next["child"]["acceptedAt"]=json!(20);next["child"]["acceptedBy"]=json!("user");let mut new_mail=mail.clone();new_mail["child"]=accepted_mailbox(&mail["child"],20).unwrap();
  let writes=vec![StateWrite{key:"kiwi.childAgentLinks".into(),expected_revision:commit::state_row(&f.db,"kiwi.childAgentLinks").unwrap()["revision"].as_i64(),value:next},StateWrite{key:"kiwi.childAgentMailbox".into(),expected_revision:commit::state_row(&f.db,"kiwi.childAgentMailbox").unwrap()["revision"].as_i64(),value:new_mail}];(f,writes)
 }
 #[test]
 fn signoff_is_one_exact_settled_activation_and_exact_local_mailbox_transform(){
  let(f,writes)=prepare_fixture();let(child,before,provider,_)=validate_accept(&f.db,&f.stamp,&writes).unwrap();assert_eq!(child,"child");assert_eq!(provider,"claude");assert_eq!(before["activationId"],"a");assert_eq!(writes[1].value["child"]["messages"][0]["state"],"cancelled");assert_eq!(writes[1].value["child"]["messages"][1]["closedAt"],20);assert!(writes[1].value["child"]["messages"][1].get("answeredAt").is_none());
  for(key,value)in[("activationId",json!("replacement")),("provider",json!("openai")),("rootThreadId",json!("other"))]{let mut changed=writes.clone();changed[0].value["child"][key]=value;assert!(validate_accept(&f.db,&f.stamp,&changed).is_err(),"{key}");}
  let mut changed=writes.clone();changed[0].value["other"]["acceptedBy"]=json!("user");assert!(validate_accept(&f.db,&f.stamp,&changed).is_err());let mut changed=writes.clone();changed[1].value["child"]["messages"][1]["answeredAt"]=json!(20);assert!(validate_accept(&f.db,&f.stamp,&changed).is_err());
 }
 #[test]
 fn signoff_plan_cannot_accept_a_newer_activation_or_delivering_guidance(){
  let(f,writes)=prepare_fixture();let(child,link,provider,_)=validate_accept(&f.db,&f.stamp,&writes).unwrap();let proof=Acceptance{child,link,provider,proof:None};let mut links=commit::state_row(&f.db,"kiwi.childAgentLinks").unwrap()["value"].clone();links["child"]["activationPending"]=json!(true);commit::write_value(&f.db,"kiwi.childAgentLinks",&links).unwrap();assert!(proof.validate(&f.db,&f.stamp,&writes).is_err());
  let(f,writes)=prepare_fixture();let mut mail=commit::state_row(&f.db,"kiwi.childAgentMailbox").unwrap()["value"].clone();mail["child"]["messages"][0]["state"]=json!("delivering");commit::write_value(&f.db,"kiwi.childAgentMailbox",&mail).unwrap();assert!(validate_accept(&f.db,&f.stamp,&writes).is_err());
 }
}
#[cfg(test)]
mod native_stop_tests{
 use super::*;
 #[test]
 fn native_stop_uses_saved_codex_lineage_and_refuses_shared_claude_processes(){
  let f=super::super::threads::tests::fixture("agents.stop");let native=json!({"native":{"childThreadId":"native","rootThreadId":"t","runtime":"codex","activationId":"activation","activationAliasId":"alias"}});commit::write_value(&f.db,"kiwi.nativeAgentLinks",&native).unwrap();let target:work::Target=serde_json::from_value(json!({"generation":1,"device":"device","kind":"turn","threadId":"native","workspaceId":"p","provider":"openai","turnId":"turn"})).unwrap();let(_,proof)=stop_link(&f.db,&f.stamp,"native",&target).unwrap();assert_eq!(proof.unwrap()["alias"],"alias");let mut wrong=f.stamp.clone();wrong.thread_id=Some("other".into());assert!(stop_link(&f.db,&wrong,"native",&target).is_err());let mut shared=native.clone();shared["native"]["runtime"]=json!("claude");commit::write_value(&f.db,"kiwi.nativeAgentLinks",&shared).unwrap();assert!(stop_link(&f.db,&f.stamp,"native",&target).unwrap_err().contains("unsupported"));
 }
}

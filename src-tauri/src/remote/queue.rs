//! A queued steer is held durably BEFORE any model input, never re-queued after crash.
use super::{commit::{self,Stamp},hostbridge,store,work,RemoteState,Inner};
use rusqlite::{params,Connection};
use serde_json::{json,Value};
use tauri::{AppHandle,State,WebviewWindow};
fn stale()->String{work::refused("stale_target")}
#[tauri::command]
pub(crate) async fn remote_work_queue_steer_claim(app:AppHandle,state:State<'_,RemoteState>,window:WebviewWindow,stamp:Stamp,queue_id:String,target_handle:String,permission:String,attempt_id:String,message_id:String,expected_revision:Option<i64>)->Result<Value,String>{
 hostbridge::window_is_host(&window).map_err(|_|stale())?;
 if [&queue_id,&target_handle,&attempt_id,&message_id].iter().any(|s|s.is_empty()||s.len()>512)||!matches!(permission.as_str(),"read-only"|"ask"|"full"){return Err(stale());}
 let s=stamp.clone();let id=queue_id.clone();let replay=state.inner.read_db(move|db|Ok(store::delivery_receipt(db,&s.device,&s.op_id,s.op_seq)?.is_some_and(|r|r["queueSteerClaim"]==id))).await?;
 if !replay {
 let mut target={let core=state.inner.lock();work::target_locked(&core,&stamp.meta(),&target_handle)?};
 let owner=crate::remote_native_owner(&app,&mut target).await?;if target.owner!=owner{return Err(stale());}
 }
 let inner=state.inner.clone();super::finish_write(state.inner.enqueue_write(false,move|db|claim(db,&inner,&stamp,&queue_id,&target_handle,&permission,&attempt_id,&message_id,expected_revision))).await
}
fn claim(db:&mut Connection,inner:&Inner,stamp:&Stamp,queue_id:&str,target_handle:&str,permission:&str,attempt:&str,message:&str,expected:Option<i64>)->Result<Value,String>{
 if commit::operation(db,stamp)?!="queue.steer"{return Err(stale());}
 let tx=db.transaction().map_err(|_|stale())?;let mut core=inner.lock();stamp.check(&core,"queue.steer")?;
 let mut receipt=store::delivery_receipt(&tx,&stamp.device,&stamp.op_id,stamp.op_seq)?.ok_or_else(stale)?;
 if receipt.get("queueSteerClaim").and_then(Value::as_str)==Some(queue_id){
  if receipt["steerTarget"]!=target_handle||receipt["attemptId"]!=attempt||receipt["messageId"]!=message{return Err(stale());}
  return Ok(json!({"rows":[commit::state_row(&tx,"kiwi.queuedTurns")?]}));
 }
 if receipt["nativeCommitted"]==true||receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|a|!a.is_empty())||matches!(receipt["disposition"].as_str(),Some("accepted"|"uncertain"|"rejected")){return Err(stale());}
 let target=work::target_locked(&core,&stamp.meta(),target_handle)?;
 if target.kind!="turn"||target.thread_id!=stamp.thread_id||target.workspace_id!=stamp.workspace_id{return Err(stale());}
 let grant=work::authorize(&core,&stamp.meta(),stamp.workspace_id.as_deref()).map_err(|_|stale())?;if permission=="full"&&!grant.capabilities.full_access{return Err(work::refused("forbidden"));}
 let mut row=commit::state_row(&tx,"kiwi.queuedTurns")?;if row["revision"].as_i64()!=expected{return Err(stale());}
 let thread=stamp.thread_id.as_deref().ok_or_else(stale)?;let entries=row["value"].get_mut(thread).and_then(Value::as_array_mut).ok_or_else(stale)?;
 let entry=entries.iter_mut().find(|e|e["id"]==queue_id).ok_or_else(stale)?;
 if entry["threadId"]!=thread||entry["editing"]==true||entry["remoteAdmissionPending"]==true||entry["status"]=="sending"||entry.get("deliverAt").is_some_and(|v|!v.is_null())&&entry.get("releasedAt").is_none_or(Value::is_null)||!entry.get("attachments").and_then(Value::as_array).is_some_and(|a|a.is_empty())||!entry["text"].as_str().is_some_and(|s|!s.trim().is_empty()){return Err(stale());}
 if let Some(old)=entry.get("remoteDelivery").filter(|v|!v.is_null()){
  if !matches!(old["disposition"].as_str(),Some("queued"|"rejected")){return Err(stale());}
  let device=old["device"].as_str().ok_or_else(stale)?;let op=old["opId"].as_str().ok_or_else(stale)?;let seq=old["opSeq"].as_u64().ok_or_else(stale)?;
  if device==stamp.device&&op==stamp.op_id{return Err(stale());}
  let mut old_receipt=store::delivery_receipt(&tx,device,op,seq)?.ok_or_else(stale)?;
  if !matches!(old_receipt["disposition"].as_str(),Some("queued"|"rejected"))||old_receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|a|a.iter().any(|v|!matches!(v.as_str(),Some("thread/start"|"thread/resume")))){return Err(stale());}
  old_receipt["disposition"]=json!("rejected");old_receipt["errorCode"]=json!("cancelled");
  tx.execute("UPDATE remote_op_journal SET state='rejected',delivery_json=?4,result_json=?5,updated_at=?6 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op,seq as i64,old_receipt.to_string(),json!({"opId":op,"state":"rejected","error":{"code":"cancelled","message":"This queued instruction was replaced by a steer."}}).to_string(),crate::unix_timestamp_ms()]).map_err(|_|stale())?;
 }
 entry["status"]=json!("sending");entry["editing"]=json!(true);entry["remoteDelivery"]=json!({"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"workspaceId":stamp.workspace_id,"generation":stamp.generation,"grantRevision":stamp.grant_revision,"attemptId":attempt,"messageId":message,"disposition":"dispatched"});
 commit::write_value(&tx,"kiwi.queuedTurns",&row["value"])?;
 receipt["queueSteerClaim"]=json!(queue_id);receipt["steerTarget"]=json!(target_handle);receipt["disposition"]=json!("dispatched");receipt["threadId"]=json!(thread);receipt["workspaceId"]=json!(stamp.workspace_id);receipt["permission"]=json!(permission);receipt["permissionCeiling"]=json!(permission);receipt["grantRevision"]=json!(stamp.grant_revision);receipt["attemptId"]=json!(attempt);receipt["messageId"]=json!(message);
 tx.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![stamp.device,stamp.op_id,stamp.op_seq as i64,receipt.to_string()]).map_err(|_|stale())?;
 let rows=json!([commit::state_row(&tx,"kiwi.queuedTurns")?]);tx.commit().map_err(|_|stale())?;
 core.work.targets.get_mut(target_handle).ok_or_else(stale)?.claimed=Some((stamp.device.clone(),stamp.op_id.clone()));Ok(json!({"rows":rows}))
}
pub(super) fn cleanup_ready(db:&Connection,stamp:&Stamp)->Result<bool,String>{
 let receipt=store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?.ok_or_else(stale)?;
 Ok(receipt["nativeCommitted"]!=true&&receipt["queueSteerClaim"].is_string()&&receipt["disposition"]=="accepted"&&receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|a|a.len()==1&&matches!(a[0].as_str(),Some("claude_turn_steer"|"cursor_turn_steer"|"codex_steer"))))
}

/// Confirmation/adoption seam for the atomic detach performed at queue admission.
#[tauri::command]
pub(crate) async fn remote_work_queue_detach_owner(state:State<'_,RemoteState>,window:WebviewWindow,stamp:Stamp,owner_handle:String,thread_id:String,queued_turn_id:String)->Result<Value,String>{
 hostbridge::window_is_host(&window).map_err(|_|stale())?;let worker=state.inner.clone();
 super::finish_write(state.inner.enqueue_write(false,move|db|{
  if commit::operation(db,&stamp)?!="prompt.scheduleNew"{return Err(stale());}
  let core=worker.lock();stamp.check(&core,"prompt.scheduleNew")?;
  let receipt=store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?.ok_or_else(stale)?;
  if receipt["disposition"]!="queued"||receipt["preparationDetached"]!=true||receipt["preparationOwner"]!=owner_handle||receipt["threadId"]!=thread_id||receipt["queuedTurnId"]!=queued_turn_id||receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|v|!v.is_empty()){return Err(stale());}
  let row=commit::state_row(db,"kiwi.queuedTurns")?;let entry=row["value"].get(&thread_id).and_then(Value::as_array).and_then(|rows|rows.iter().find(|r|r["id"]==queued_turn_id)).ok_or_else(stale)?;
  if entry["remoteDelivery"]["device"]!=stamp.device||entry["remoteDelivery"]["opId"]!=stamp.op_id||entry["remoteDelivery"]["opSeq"]!=stamp.op_seq||entry["remoteDelivery"]["ownerHandle"].is_string(){return Err(stale());}
  Ok(json!({"detached":true,"rows":[row]}))
 })).await
}

#[cfg(test)]
mod tests{
 use super::*;
 fn queued(_f:&super::super::threads::tests::Fixture)->Value{json!({"t":[{"id":"q","threadId":"t","text":"exact queued text","attachments":[],"status":"queued"}] ,"other":[]})}
 fn target(f:&super::super::threads::tests::Fixture){let mut t:work::Target=serde_json::from_value(json!({"generation":1,"device":"device","kind":"turn","threadId":"t","workspaceId":"p","provider":"claude","turnId":"turn"})).unwrap();t.revision=f.stamp.grant_revision;t.expires=Some(std::time::Instant::now()+std::time::Duration::from_secs(60));f.inner.lock().work.targets.insert("target".into(),t);}
 #[test]
 fn steer_claim_is_atomic_replayable_and_cleanup_requires_actual_input(){
  let mut f=super::super::threads::tests::fixture("queue.steer");target(&f);commit::write_value(&f.db,"kiwi.queuedTurns",&queued(&f)).unwrap();let expected=commit::state_row(&f.db,"kiwi.queuedTurns").unwrap()["revision"].as_i64();
  let a=claim(&mut f.db,&f.inner,&f.stamp,"q","target","ask","attempt","message",expected).unwrap();assert_eq!(a["rows"][0]["value"]["t"][0]["status"],"sending");assert_eq!(a["rows"][0]["value"]["t"][0]["text"],"exact queued text");assert_eq!(f.inner.lock().work.targets["target"].claimed,Some(("device".into(),"op".into())));
  assert_eq!(claim(&mut f.db,&f.inner,&f.stamp,"q","target","ask","attempt","message",None).unwrap(),a);assert!(claim(&mut f.db,&f.inner,&f.stamp,"q","target","ask","changed","message",expected).is_err());assert!(!cleanup_ready(&f.db,&f.stamp).unwrap());
  let row=commit::state_row(&f.db,"kiwi.queuedTurns").unwrap();let mut writes=vec![commit::StateWrite{key:"kiwi.queuedTurns".into(),expected_revision:row["revision"].as_i64(),value:json!({"t":[],"other":[]})}];assert!(commit::commit_state(&mut f.db,&f.inner,&f.stamp,&mut writes,&[],false,None).is_err());
  store::claim_native_step(&mut f.db,"device","op",1,"claude_turn_steer").unwrap();let mut receipt=store::delivery_receipt(&f.db,"device","op",1).unwrap().unwrap();receipt["disposition"]=json!("accepted");store::save_native_delivery_receipt(&mut f.db,"device","op",1,&receipt).unwrap();assert!(cleanup_ready(&f.db,&f.stamp).unwrap());
  let done=commit::commit_state(&mut f.db,&f.inner,&f.stamp,&mut writes,&[],false,None).unwrap();assert_eq!(done["result"]["state"],"accepted");assert_eq!(commit::commit_state(&mut f.db,&f.inner,&f.stamp,&mut writes,&[],false,None).unwrap()["replayed"],true);
 }
 #[test]
 fn steer_rejects_stale_revision_timed_attachments_editing_and_revocation(){
  for (key,value) in [("editing",json!(true)),("remoteAdmissionPending",json!(true)),("attachments",json!([{"id":"a"}])),("deliverAt",json!(1)),("status",json!("sending"))]{let mut f=super::super::threads::tests::fixture("queue.steer");target(&f);let mut q=queued(&f);q["t"][0][key]=value;commit::write_value(&f.db,"kiwi.queuedTurns",&q).unwrap();let rev=commit::state_row(&f.db,"kiwi.queuedTurns").unwrap()["revision"].as_i64();assert!(claim(&mut f.db,&f.inner,&f.stamp,"q","target","ask","a","m",rev).is_err(),"{key}");assert_eq!(commit::state_row(&f.db,"kiwi.queuedTurns").unwrap()["value"],q);}
  let mut f=super::super::threads::tests::fixture("queue.steer");target(&f);commit::write_value(&f.db,"kiwi.queuedTurns",&queued(&f)).unwrap();assert!(claim(&mut f.db,&f.inner,&f.stamp,"q","target","ask","a","m",None).is_err());let rev=commit::state_row(&f.db,"kiwi.queuedTurns").unwrap()["revision"].as_i64();f.inner.lock().devices.get_mut("device").unwrap().grant.as_mut().unwrap().work=false;assert!(claim(&mut f.db,&f.inner,&f.stamp,"q","target","ask","a","m",rev).is_err());
 }
}

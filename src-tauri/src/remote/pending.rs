//! Host-only approval recovery. Missing bodies are PRESENT, never absence proof.
use serde_json::{json,Value};
const MAX_BODY:usize=128*1024;
const MAX_PAYLOADS:usize=3*1024*1024-1024;
const MAX_IDENTITIES:usize=1024*1024-1024;
struct BodySize(usize);
impl std::io::Write for BodySize{
 fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{if bytes.len()>MAX_BODY.saturating_sub(self.0){return Err(std::io::Error::other("approval body omitted"));}self.0+=bytes.len();Ok(bytes.len())}
 fn flush(&mut self)->std::io::Result<()>{Ok(())}
}
fn body_size(params:&Value)->Option<usize>{let mut count=BodySize(0);serde_json::to_writer(&mut count,params).ok()?;Some(count.0)}
#[derive(Default)]
pub(crate) struct Inventory{requests:Vec<Value>,present:Vec<Value>,payload_bytes:usize,identity_bytes:usize,incomplete:bool}
impl Inventory{
 pub(crate) fn incomplete(&mut self){self.incomplete=true;}
 pub(crate) fn push(&mut self,id:Value,method:&str,thread:&str,params:&Value,turn:Option<&str>,item:Option<&str>,now:i64){
  let valid=|s:&str|!s.is_empty()&&s.len()<=512&&!s.chars().any(char::is_control);
  if !valid(method)||!valid(thread)||!match &id{Value::String(s)=>valid(s),Value::Number(n)=>n.as_i64().is_some_and(|n|n.unsigned_abs()<=9_007_199_254_740_991),_=>false}{self.incomplete=true;return;}
  let mut identity=json!({"id":id,"method":method,"threadId":thread});
  for(key,value)in[("turnId",turn),("itemId",item)]{if let Some(value)=value{if !valid(value){self.incomplete=true;return;}identity[key]=json!(value);}}
  // Measure before cloning. A single giant/null body cannot discard its peers.
  let identity_size=serde_json::to_vec(&identity).map_or(MAX_IDENTITIES,|b|b.len());
  if params.is_object(){if let Some(body)=body_size(params){let reserve=body+identity_size+96;if self.requests.len()<1024&&self.payload_bytes+reserve<=MAX_PAYLOADS{
   let mut payload=identity.clone();payload["params"]=params.clone();payload["receivedAt"]=json!(now);self.payload_bytes+=reserve;self.requests.push(payload);return;
  }}}
  let size=identity_size+1;if self.present.len()>=4096||self.identity_bytes+size>MAX_IDENTITIES{self.incomplete=true;return;}self.identity_bytes+=size;self.present.push(identity);
 }
 pub(crate) fn finish(self)->Value{json!({"complete":!self.incomplete,"requests":self.requests,"present":self.present})}
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]
 fn missing_or_oversized_body_never_erases_other_approvals_or_proves_expiry(){
  let mut i=Inventory::default();i.push(json!(1),"item/approval","missing",&Value::Null,Some("turn"),Some("item"),1);i.push(json!(2),"item/approval","large",&json!({"command":"secret".repeat(MAX_BODY)}),None,None,1);i.push(json!(3),"item/approval","good",&json!({"command":"pwd"}),None,None,1);
  let out=i.finish();assert_eq!(out["complete"],true);assert_eq!(out["requests"].as_array().unwrap().len(),1);assert_eq!(out["requests"][0]["threadId"],"good");assert_eq!(out["present"].as_array().unwrap().len(),2);assert_eq!(out["present"][0]["turnId"],"turn");assert_eq!(out["present"][0]["itemId"],"item");assert!(out["present"][1].get("params").is_none());assert!(out.get("expired").is_none());assert!(out["requests"][0].get("remoteOwner").is_none());
 }
 #[test]
 fn recovery_budgets_omit_bodies_individually_without_marking_absence(){
  let mut i=Inventory::default();let body=json!({"text":"x".repeat(100_000)});for id in 0..64{i.push(json!(id),"approval","thread",&body,None,None,1);}let out=i.finish();assert_eq!(out["complete"],true);assert!(out["requests"].as_array().unwrap().len()>1);assert!(!out["present"].as_array().unwrap().is_empty());assert_eq!(out["requests"].as_array().unwrap().len()+out["present"].as_array().unwrap().len(),64);assert!(serde_json::to_vec(&out).unwrap().len()<4*1024*1024);
 }
}

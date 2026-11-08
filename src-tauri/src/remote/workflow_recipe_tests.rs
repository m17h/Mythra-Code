use super::*;
#[test]
fn workflow_start_digest_wire_is_optional_but_exact_sha256_lower_hex_when_present() {
    let mut args = json!({"opId":"recipe","opSeq":1,"workspaceId":"p","workflowId":"wf","revision":"r"});
    assert!(validate_args("workflows.start", &args).is_ok());
    args["digest"] = json!("a".repeat(64));
    assert!(validate_args("workflows.start", &args).is_ok());
    for bad in [json!("A".repeat(64)), json!("g".repeat(64)), json!("a".repeat(63)), json!("a".repeat(65)), json!(42), Value::Null] {
        args["digest"] = bad;
        assert!(validate_args("workflows.start", &args).is_err());
    }
    args["digest"] = json!("a".repeat(64));
    assert!(validate_args("workflows.stop", &args).is_err());
}
#[test]
fn changed_recipe_refusal_keeps_exact_host_explanation_on_journal_replay() {
    let mut f = super::super::threads::tests::fixture("workflows.start");
    let receipt = json!({"disposition":"rejected","errorCode":"workflow_changed","workspaceId":"p","threadId":"t","workflowChangedHost":"Fixture host"});
    store::save_delivery_receipt(&mut f.db, "device", "op", 1, &receipt).unwrap();
    let reply = store::operation_result(&f.db, "device", "op").unwrap();
    assert_eq!(reply["state"], "rejected");
    assert_eq!(reply["error"]["code"], "workflow_changed");
    assert_eq!(reply["error"]["message"], "This workflow changed on Fixture host after you reviewed it. Review it again before running.");
    store::save_operation_result(&f.db,"device","op",1,&json!({"opId":"op","state":"rejected","error":{"code":"workflow_changed","message":"generic renderer message"}})).unwrap();
    assert_eq!(store::operation_result(&f.db,"device","op").unwrap(), reply);
}

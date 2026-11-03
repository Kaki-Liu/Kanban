use super::*;
struct Fixture {
    store: Store,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("kanban-exchange-{}", Uuid::new_v4()));
        let mut store = Store::new(dir.join("kanban.db")).unwrap();
        store.set_now("2026-11-03T01:00:00Z").unwrap();
        Self { store, dir }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let old = std::mem::replace(&mut self.store.db, Connection::open_in_memory().unwrap());
        drop(old);
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn task(id: &str) -> Value {
    json!({"id":id,"type":"task","title":"测试事项","schedule":{"frequency":"daily","start_date":"2026-11-03"}})
}

#[test]
fn validation_defaults_strict_dates_and_cycles() {
    let c = validate("item", task("sample")).unwrap();
    assert_eq!(c["schedule"]["timezone"], "Asia/Shanghai");
    assert_eq!(c["project_id"], Value::Null);
    for schedule in [
        json!({"frequency":"once","date":"2026-11-03"}),
        json!({"frequency":"weekdays","start_date":"2026-11-03"}),
        json!({"frequency":"weekly","start_date":"2026-11-03","weekdays":[1]}),
    ] {
        let mut input = task("schedule-default");
        input["schedule"] = schedule;
        assert_eq!(
            validate("item", input).unwrap()["schedule"]["timezone"],
            "Asia/Shanghai"
        );
    }
    let mut bad = task("bad");
    bad["schedule"]["start_date"] = json!("2026-02-30");
    assert!(validate("item", bad).is_err());
    let mut bad = task("bad");
    bad["unknown"] = json!(true);
    assert!(validate("item", bad).is_err());
    let w = validate(
        "workflow",
        json!({"mode":"kanban","tasks":[{"id":"first","title":"第一项"}]}),
    )
    .unwrap();
    assert_eq!(w["tasks"][0]["handoff"]["status"], "draft");
    assert!(validate("workflow",json!({"mode":"kanban","tasks":[{"id":"a","title":"A","dependsOn":["b"]},{"id":"b","title":"B","dependsOn":["a"]}]})).is_err());
    assert!(validate(
        "workflow",
        json!({"mode":"kanban","tasks":[{"id":"a","title":"A","state":"done"}]})
    )
    .is_err());
}
#[test]
fn import_is_idempotent_and_stale_preview_does_not_write() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    let config = json!({"schema_version":1,"items":[task("a")]}).to_string();
    let p = s.preview_import(&config).unwrap();
    s.commit_import(text(&p, "token")).unwrap();
    let p = s.preview_import(&config).unwrap();
    assert_eq!(p["changes"][0]["action"], "unchanged");
    s.commit_import(text(&p, "token")).unwrap();
    assert_eq!(s.templates().unwrap().len(), 1);
    let p = s
        .preview_import(&json!({"schema_version":1,"items":[task("b")]}).to_string())
        .unwrap();
    s.save_log(json!({"body":"另一个窗口的操作","date":s.day()}))
        .unwrap();
    assert!(s.commit_import(text(&p, "token")).is_err());
    assert_eq!(s.templates().unwrap().len(), 1);
    let mut invalid = task("invalid");
    invalid["project_id"] = json!("missing");
    assert!(s
        .preview_import(&json!({"schema_version":1,"items":[task("new"),invalid]}).to_string())
        .is_err());
    assert_eq!(s.templates().unwrap().len(), 1);
}
#[test]
fn project_import_binds_target_and_protects_started_records() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_project(json!({"id":"project","name":"项目","workflow":{"mode":"kanban","tasks":[{"id":"t","title":"原有任务","state":"doing"}]}})).unwrap();
    let w=validate("workflow",json!({"mode":"kanban","tasks":[{"id":"t","title":"原有任务","state":"todo","hasStarted":false}]})).unwrap();
    s.save_workflow("project", w, s.revision().unwrap())
        .unwrap();
    assert_eq!(
        s.project("project").unwrap().unwrap()["workflow"]["tasks"][0]["hasStarted"],
        true
    );
    let input=json!({"schema_version":1,"kind":"kanban-project","project":{"id":"project","name":"更新名称","workflow":{"mode":"kanban","tasks":[{"id":"t","title":"不应覆盖"}]}}}).to_string();
    let preview = s.preview_project_config(&input, Some("project")).unwrap();
    assert_eq!(preview["protectedCount"], 1);
    s.commit_project_config(text(&preview, "token")).unwrap();
    let p = s.project("project").unwrap().unwrap();
    assert_eq!(p["name"], "更新名称");
    assert_eq!(p["workflow"]["tasks"][0]["title"], "原有任务");
    s.save_project(json!({"id":"other","name":"其他项目"}))
        .unwrap();
    assert!(s.preview_project_config(&input, Some("other")).is_err());
}
#[test]
fn workflow_completion_log_deduplicates_and_agent_claims_are_downgraded() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_project(json!({"id":"p","name":"项目"})).unwrap();
    let mut w=validate("workflow",json!({"mode":"kanban","tasks":[{"id":"t","title":"任务","state":"done","acceptance":"能操作","evidence":"已验证"}]})).unwrap();
    s.save_workflow("p", w.clone(), s.revision().unwrap())
        .unwrap();
    w["tasks"][0]["state"] = json!("todo");
    s.save_workflow("p", w.clone(), s.revision().unwrap())
        .unwrap();
    w["tasks"][0]["state"] = json!("done");
    s.save_workflow("p", w.clone(), s.revision().unwrap())
        .unwrap();
    assert_eq!(s.entities("logs").unwrap().len(), 1);
    let p=s.preview_project_config(&json!({"schema_version":1,"kind":"kanban-project","project":{"name":"新项目","workflow":w}}).to_string(),None).unwrap();
    let id = s.commit_project_config(text(&p, "token")).unwrap();
    assert_eq!(
        s.project(&id).unwrap().unwrap()["workflow"]["tasks"][0]["state"],
        "review"
    );
}
#[test]
fn backup_restores_existing_format_and_rejects_tampering() {
    let mut f = Fixture::new();
    let path = f.dir.join("snapshot.kanban-backup");
    let s = &mut f.store;
    s.save_project(json!({"id":"p","name":"备份中的项目"}))
        .unwrap();
    s.save_log(json!({"body":"原始记录","date":s.day(),"projectId":"p"}))
        .unwrap();
    s.create_backup(&path).unwrap();
    s.save_log(json!({"body":"恢复后消失","date":s.day()}))
        .unwrap();
    let p = s.preview_backup(&path).unwrap();
    s.restore_backup(text(&p, "token")).unwrap();
    assert_eq!(s.entities("logs").unwrap().len(), 1);
    assert!(f.dir.join("backups").exists());
    let p = s.preview_backup(&path).unwrap();
    let copy = Connection::open(&path).unwrap();
    copy.execute(
        "UPDATE meta SET value='tampered' WHERE key='backup_created'",
        [],
    )
    .unwrap();
    drop(copy);
    assert!(s.restore_backup(text(&p, "token")).is_err());
    assert_eq!(s.entities("logs").unwrap().len(), 1);
    let invalid = f.dir.join("invalid.kanban-backup");
    fs::write(&invalid, b"not sqlite").unwrap();
    assert!(s.preview_backup(&invalid).is_err());
    assert!(s.create_backup(&s.path).is_err());
}
#[test]
fn upgrade_snapshot_is_once_and_project_export_excludes_notes() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_project(json!({"id":"p","name":"保留项目"})).unwrap();
    s.save_note(json!({"title":"私密","body":"PRIVATE","projectId":"p"}))
        .unwrap();
    s.prepare_version("0.4.0").unwrap();
    s.prepare_version("0.4.0").unwrap();
    assert_eq!(fs::read_dir(f.dir.join("backups")).unwrap().count(), 1);
    assert!(!s
        .export_project_config(Some("p"))
        .unwrap()
        .contains("PRIVATE"));
    assert!(validate(
        "projectConfig",
        serde_json::from_str(include_str!("../schemas/project-template.json")).unwrap()
    )
    .is_ok());
}

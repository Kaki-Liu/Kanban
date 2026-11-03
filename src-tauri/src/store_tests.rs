use super::*;
struct Fixture {
    store: Store,
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("kanban-rust-{}", uuid()));
        let mut store = Store::new(directory.join("kanban.db")).unwrap();
        store.set_now("2026-11-03T01:00:00Z").unwrap();
        Self { store, directory }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let old = std::mem::replace(&mut self.store.db, Connection::open_in_memory().unwrap());
        drop(old);
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn config(id: &str) -> Value {
    json!({"id":id,"type":"checklist","title":"运维检查","checklist":[{"id":"a","text":"检查服务"},{"id":"b","text":"核对告警"}],"schedule":{"frequency":"daily","start_date":"2026-11-03","time":"09:30"},"reminder":{"popup":true,"snooze_minutes":10}})
}

#[test]
fn only_today_generated_and_pause_recovery() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_item(config("daily"), None).unwrap();
    assert_eq!(s.runs().unwrap().len(), 1);
    s.ensure_today().unwrap();
    assert_eq!(s.runs().unwrap().len(), 1);
    s.set_now("2026-11-06T01:00:00Z").unwrap();
    s.ensure_today().unwrap();
    assert_eq!(s.runs().unwrap().len(), 2);
    s.set_mode("daily", true, false).unwrap();
    s.set_now("2026-11-07T01:00:00Z").unwrap();
    assert!(!s.ensure_today().unwrap());
    s.set_mode("daily", false, false).unwrap();
    assert_eq!(s.runs().unwrap().len(), 3);
}
#[test]
fn untouched_updates_protect_started_and_withdraw_changed_rule() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_item(config("daily"), None).unwrap();
    let id = text(&s.runs().unwrap()[0], "id").to_string();
    let mut changed = config("daily");
    changed["title"] = json!("第一次修改");
    s.save_item(changed.clone(), None).unwrap();
    assert_eq!(s.get_run(&id).unwrap()["config"]["title"], "第一次修改");
    s.check(&id, "a", true).unwrap();
    s.check(&id, "a", false).unwrap();
    changed["title"] = json!("第二次修改");
    s.save_item(changed, None).unwrap();
    assert_eq!(s.get_run(&id).unwrap()["config"]["title"], "第一次修改");
    s.save_item(config("untouched"), None).unwrap();
    let id = text(
        &s.runs()
            .unwrap()
            .into_iter()
            .find(|r| r["templateId"] == "untouched")
            .unwrap(),
        "id",
    )
    .to_string();
    let mut changed = config("untouched");
    changed["schedule"] = json!({"frequency":"weekly","start_date":"2026-11-03","weekdays":[7]});
    changed["reminder"]["popup"] = json!(false);
    s.save_item(changed, None).unwrap();
    assert_eq!(s.get_run(&id).unwrap()["state"], "withdrawn");
}
#[test]
fn reminders_snooze_restart_and_reopen_do_not_realert() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_item(config("daily"), None).unwrap();
    let id = text(&s.runs().unwrap()[0], "id").to_string();
    s.set_now("2026-11-03T01:30:00Z").unwrap();
    assert_eq!(s.due_reminders().unwrap().len(), 1);
    s.mark_shown(&[id.clone()]).unwrap();
    assert_eq!(s.due_reminders().unwrap().len(), 0);
    s.set_now("2026-11-03T15:55:00Z").unwrap();
    s.snooze(&id).unwrap();
    s.set_now("2026-11-03T16:06:00Z").unwrap();
    assert_eq!(s.due_reminders().unwrap().len(), 1);
    s.state(&id, "completed", "一切正常", "").unwrap();
    s.state(&id, "pending", "", "").unwrap();
    assert_eq!(s.due_reminders().unwrap().len(), 0);
    assert_eq!(s.entities("logs").unwrap().len(), 1);
}
#[test]
fn widget_forecasts_do_not_generate_runs_and_layout_does_not_invalidate_revision() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    let mut c = config("future");
    c["schedule"]["start_date"] = json!("2026-12-01");
    s.save_item(c, None).unwrap();
    let snapshot = s.widget_snapshot().unwrap();
    assert_eq!(snapshot["upcoming"].as_array().unwrap().len(), 2);
    assert_eq!(s.runs().unwrap().len(), 0);
    let revision = s.revision().unwrap();
    s.save_widget_preferences(json!({"visible":true,"pinned":false}))
        .unwrap();
    assert_eq!(revision, s.revision().unwrap());
    assert_eq!(s.widget_preferences().unwrap()["pinned"], false);
}
#[test]
fn report_merges_associated_results_excludes_notes_and_uses_log_attributed_date() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_item(config("daily"), None).unwrap();
    let id = text(&s.runs().unwrap()[0], "id").to_string();
    s.state(&id, "completed", "检查无异常", "").unwrap();
    s.save_log(json!({"body":"补记工作","date":"2026-11-02"}))
        .unwrap();
    s.save_note(json!({"title":"私密","body":"不进入汇报"}))
        .unwrap();
    let report = s
        .report(json!({"from":"2026-11-02","to":"2026-11-03","includePending":false}))
        .unwrap();
    assert_eq!(report.as_array().unwrap().len(), 2);
    assert_eq!(report[0]["date"], "2026-11-02");
    assert_eq!(report[1]["body"], "2026-11-03：检查无异常");
    assert!(!report.to_string().contains("不进入汇报"));
}
#[test]
fn database_is_electron_schema_compatible_and_invalid_writes_rollback() {
    let mut f = Fixture::new();
    let s = &mut f.store;
    s.save_item(config("daily"), None).unwrap();
    let rev = s.revision().unwrap();
    let mut c = config("bad");
    c["project_id"] = json!("missing");
    assert!(s.save_item(c, None).is_err());
    let c = s.validate_config(config("rolled-back")).unwrap();
    let rollback: Result<()> = s.transaction(|s| {
        s.apply(c, None)?;
        Err("模拟事务提交前失败".into())
    });
    assert!(rollback.is_err());
    assert_eq!(rev, s.revision().unwrap());
    assert_eq!(s.templates().unwrap().len(), 1);
}

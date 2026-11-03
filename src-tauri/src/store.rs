use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub(crate) fn boolean(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn uuid() -> String {
    Uuid::new_v4().to_string()
}
pub(crate) fn parse_date(day: &str) -> Result<NaiveDate> {
    let d = NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| "日期不存在".to_string())?;
    if d.format("%Y-%m-%d").to_string() != day {
        return Err("日期格式无效".into());
    }
    Ok(d)
}
pub(crate) fn matches(config: &Value, day: &str) -> bool {
    let s = &config["schedule"];
    if text(s, "frequency") == "once" {
        return text(s, "date") == day;
    }
    if day < text(s, "start_date") {
        return false;
    }
    let Ok(date) = parse_date(day) else {
        return false;
    };
    let weekday = date.weekday().number_from_monday();
    match text(s, "frequency") {
        "daily" => true,
        "weekdays" => weekday <= 5,
        "weekly" => s["weekdays"]
            .as_array()
            .is_some_and(|days| days.iter().any(|d| d.as_u64() == Some(weekday as u64))),
        _ => false,
    }
}
pub(crate) fn editable(run: &Value) -> bool {
    ["pending", "withdrawn"].contains(&text(run, "state"))
        && run["startedAt"].is_null()
        && !boolean(run, "manual")
}
fn at_time(day: &str, time: &str) -> Result<String> {
    DateTime::parse_from_rfc3339(&format!("{day}T{time}:00+08:00"))
        .map(|d| {
            d.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(error)
}
fn china_day(date: DateTime<Utc>) -> String {
    date.with_timezone(&FixedOffset::east_opt(28800).unwrap())
        .format("%Y-%m-%d")
        .to_string()
}
fn pending(run: &Value) -> bool {
    ["pending", "doing"].contains(&text(run, "state"))
}
fn sql_nullable(v: &Value) -> Option<&str> {
    v.as_str()
}

pub struct Store {
    pub(crate) db: Connection,
    pub path: PathBuf,
    pub(crate) previews: HashMap<String, Value>,
    pub clock: Option<DateTime<Utc>>,
}
impl Store {
    pub fn new(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(error)?;
        }
        let db = Connection::open(&path).map_err(error)?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
        )
        .map_err(error)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(error)?;
        if version > 1 {
            return Err("数据版本高于此程序，请使用更新版本打开。".into());
        }
        if version == 0 {
            db.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE notes(id TEXT PRIMARY KEY, data TEXT NOT NULL, project_id TEXT REFERENCES projects(id));
                CREATE TABLE templates(id TEXT PRIMARY KEY, config TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, note_id TEXT REFERENCES notes(id) ON DELETE SET NULL);
                CREATE TABLE runs(id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES templates(id), day TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(template_id,day));
                CREATE TABLE reminders(run_id TEXT PRIMARY KEY REFERENCES runs(id), due_at TEXT NOT NULL, status TEXT NOT NULL, snoozed INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX reminders_due ON reminders(status,due_at);
                CREATE TABLE logs(id TEXT PRIMARY KEY, data TEXT NOT NULL, run_id TEXT REFERENCES runs(id), project_id TEXT REFERENCES projects(id));
                CREATE INDEX logs_run ON logs(run_id);
                CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                INSERT INTO meta VALUES('revision','0');
                INSERT INTO meta VALUES('settings','{\"shortcut\":\"Ctrl+Alt+J\",\"autoStart\":false}');
                PRAGMA application_id=1262571074; PRAGMA user_version=1; COMMIT;").map_err(error)?;
        }
        let app_id: i64 = db
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(error)?;
        if app_id != 1262571074 {
            return Err("文件不是工作看板数据库".into());
        }
        Ok(Self {
            db,
            path,
            previews: HashMap::new(),
            clock: None,
        })
    }
    pub fn now(&self) -> String {
        self.clock
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }
    pub fn set_now(&mut self, value: &str) -> Result<()> {
        self.clock = Some(
            DateTime::parse_from_rfc3339(value)
                .map_err(error)?
                .with_timezone(&Utc),
        );
        Ok(())
    }
    pub fn day(&self) -> String {
        china_day(self.clock.unwrap_or_else(Utc::now))
    }
    pub fn revision(&self) -> Result<i64> {
        self.db
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='revision'",
                [],
                |r| r.get(0),
            )
            .map_err(error)
    }
    pub(crate) fn transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(error)?;
        let result = operation(self).and_then(|value| {
            self.db
                .execute(
                    "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
                    [],
                )
                .map_err(error)?;
            self.db.execute_batch("COMMIT").map_err(error)?;
            Ok(value)
        });
        if result.is_err() {
            let _ = self.db.execute_batch("ROLLBACK");
        }
        result
    }
    pub(crate) fn entities(&self, table: &str) -> Result<Vec<Value>> {
        if !["projects", "runs", "logs", "notes"].contains(&table) {
            return Err("无效数据表".into());
        }
        let mut stmt = self
            .db
            .prepare(&format!("SELECT data FROM {table}"))
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(error)?;
        rows.map(|row| serde_json::from_str(&row.map_err(error)?).map_err(error))
            .collect()
    }
    pub fn templates(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT id,config,paused,archived,note_id FROM templates")
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(error)?;
        rows.map(|row| {
            let (id, raw, paused, archived, note) = row.map_err(error)?;
            let config: Value = serde_json::from_str(&raw).map_err(error)?;
            Ok(json!({"id":id,"config":config,"paused":paused,"archived":archived,"noteId":note}))
        })
        .collect()
    }
    pub fn runs(&self) -> Result<Vec<Value>> {
        self.entities("runs")
    }
    pub fn get_run(&self, id: &str) -> Result<Value> {
        let row: Option<String> = self
            .db
            .query_row("SELECT data FROM runs WHERE id=?", [id], |r| r.get(0))
            .optional()
            .map_err(error)?;
        serde_json::from_str(&row.ok_or("事项不存在")?).map_err(error)
    }
    pub(crate) fn put_run(&self, run: &Value) -> Result<()> {
        self.db.execute("INSERT INTO runs(id,template_id,day,state,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,state=excluded.state,data=excluded.data",params![text(run,"id"),text(run,"templateId"),text(run,"date"),text(run,"state"),run.to_string()]).map_err(error)?;
        Ok(())
    }
    pub(crate) fn project_exists(&self, id: &Value) -> Result<()> {
        if id.is_null() {
            return Ok(());
        }
        let id = id.as_str().ok_or("项目 ID 必须是字符串")?;
        if !self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(error)?
        {
            return Err("项目不存在".into());
        }
        Ok(())
    }
    pub(crate) fn validate_config(&self, input: Value) -> Result<Value> {
        let config = crate::validation::validate("item", input)?;
        self.project_exists(&config["project_id"])?;
        Ok(config)
    }
    fn set_reminder(&self, run: &Value, reset: bool) -> Result<()> {
        if !boolean(&run["config"]["reminder"], "popup")
            || text(&run["config"]["schedule"], "time").is_empty()
            || !pending(run)
        {
            self.db
                .execute(
                    "UPDATE reminders SET status='cancelled' WHERE run_id=?",
                    [text(run, "id")],
                )
                .map_err(error)?;
            return Ok(());
        }
        let due = at_time(text(run, "date"), text(&run["config"]["schedule"], "time"))?;
        let suffix = if reset {
            "DO UPDATE SET due_at=excluded.due_at,status='pending',snoozed=0"
        } else {
            "DO NOTHING"
        };
        self.db.execute(&format!("INSERT INTO reminders(run_id,due_at,status,snoozed) VALUES(?,?,'pending',0) ON CONFLICT(run_id) {suffix}"),params![text(run,"id"),due]).map_err(error)?;
        Ok(())
    }
    fn has_run(&self, id: &str, day: &str) -> Result<bool> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM runs WHERE template_id=? AND day=?)",
                params![id, day],
                |r| r.get(0),
            )
            .map_err(error)
    }
    fn generate(&self, template: &Value) -> Result<()> {
        if boolean(template, "paused") || boolean(template, "archived") {
            return Ok(());
        }
        let config = &template["config"];
        let day = if text(&config["schedule"], "frequency") == "once" {
            text(&config["schedule"], "date").to_string()
        } else {
            self.day()
        };
        if !matches(config, &day) || self.has_run(text(template, "id"), &day)? {
            return Ok(());
        }
        let run = json!({"id":uuid(),"templateId":template["id"],"date":day,"config":config,"state":"pending","checks":{},"startedAt":null,"completedAt":null,"changedAt":self.now(),"manual":false,"skipReason":""});
        self.put_run(&run)?;
        self.set_reminder(&run, false)
    }
    pub fn ensure_today(&mut self) -> Result<bool> {
        let mut missing = Vec::new();
        for template in self.templates()? {
            let config = &template["config"];
            let day = if text(&config["schedule"], "frequency") == "once" {
                text(&config["schedule"], "date").to_string()
            } else {
                self.day()
            };
            if !boolean(&template, "paused")
                && !boolean(&template, "archived")
                && matches(config, &day)
                && !self.has_run(text(&template, "id"), &day)?
            {
                missing.push(template);
            }
        }
        if missing.is_empty() {
            return Ok(false);
        }
        self.transaction(|store| {
            for template in missing {
                store.generate(&template)?;
            }
            Ok(true)
        })
    }
    pub fn snapshot(&mut self) -> Result<Value> {
        self.ensure_today()?;
        Ok(
            json!({"today":self.day(),"revision":self.revision()?,"templates":self.templates()?,"runs":self.runs()?,"projects":self.entities("projects")?,"logs":self.entities("logs")?,"notes":self.entities("notes")?,"settings":self.settings()?,"dataPath":self.path}),
        )
    }
    pub(crate) fn apply(&mut self, config: Value, note_id: Option<String>) -> Result<()> {
        let old = self
            .templates()?
            .into_iter()
            .find(|t| t["id"] == config["id"]);
        if old.as_ref().is_some_and(|t| t["config"] == config) && note_id.is_none() {
            return Ok(());
        }
        if let Some(note) = &note_id {
            if !self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?)",
                    [note],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(error)?
            {
                return Err("关联笔记不存在".into());
            }
        }
        self.db.execute("INSERT INTO templates(id,config,note_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,note_id=COALESCE(excluded.note_id,templates.note_id)",params![text(&config,"id"),config.to_string(),note_id]).map_err(error)?;
        if old.is_some() {
            for mut run in self.runs()?.into_iter().filter(|r| {
                r["templateId"] == config["id"]
                    && text(r, "date") >= self.day().as_str()
                    && editable(r)
            }) {
                let valid = matches(&config, text(&run, "date"));
                let reset = text(&run, "state") == "withdrawn"
                    || run["config"]["schedule"]["time"] != config["schedule"]["time"]
                    || run["config"]["reminder"]["popup"] != config["reminder"]["popup"]
                    || !valid;
                run["config"] = config.clone();
                run["checks"] = json!({});
                run["changedAt"] = json!(self.now());
                run["state"] = json!(if valid { "pending" } else { "withdrawn" });
                self.put_run(&run)?;
                self.set_reminder(&run, reset)?;
            }
        }
        let paused = old.as_ref().is_some_and(|t| boolean(t, "paused"));
        let archived = old.as_ref().is_some_and(|t| boolean(t, "archived"));
        self.generate(
            &json!({"id":config["id"],"config":config,"paused":paused,"archived":archived}),
        )?;
        if paused || archived {
            self.cancel_template(text(&config, "id"))?;
        }
        Ok(())
    }
    pub fn save_item(&mut self, input: Value, note_id: Option<String>) -> Result<()> {
        let config = self.validate_config(input)?;
        self.transaction(|s| s.apply(config, note_id))
    }
    fn cancel_template(&self, id: &str) -> Result<()> {
        self.db.execute("UPDATE reminders SET status='cancelled' WHERE run_id IN (SELECT id FROM runs WHERE template_id=?)",[id]).map_err(error)?;
        Ok(())
    }
    pub fn set_mode(&mut self, id: &str, paused: bool, archived: bool) -> Result<()> {
        let mut template = self
            .templates()?
            .into_iter()
            .find(|t| text(t, "id") == id)
            .ok_or("配置不存在")?;
        self.transaction(|s| {
            s.db.execute(
                "UPDATE templates SET paused=?,archived=? WHERE id=?",
                params![paused, archived, id],
            )
            .map_err(error)?;
            if paused || archived {
                s.cancel_template(id)?;
            } else {
                template["paused"] = json!(false);
                template["archived"] = json!(false);
                s.generate(&template)?;
                for run in s.runs()?.into_iter().filter(|r| {
                    text(r, "templateId") == id
                        && text(r, "date") >= s.day().as_str()
                        && text(r, "state") == "pending"
                        && r["startedAt"].is_null()
                }) {
                    s.set_reminder(&run, true)?;
                }
            }
            Ok(())
        })
    }
    pub fn check(&mut self, id: &str, key: &str, checked: bool) -> Result<()> {
        self.transaction(|s| {
            let mut run = s.get_run(id)?;
            if !pending(&run)
                || !run["config"]["checklist"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|c| text(c, "id") == key))
            {
                return Err("无法修改此子项，请先重新打开事项".into());
            }
            run["checks"][key] = json!(checked);
            if run["startedAt"].is_null() {
                run["startedAt"] = json!(s.now());
            }
            run["changedAt"] = json!(s.now());
            s.put_run(&run)
        })
    }
    pub fn state(&mut self, id: &str, state: &str, result: &str, reason: &str) -> Result<()> {
        if !["pending", "doing", "completed", "skipped"].contains(&state) {
            return Err("无效状态".into());
        }
        if result.chars().count() > 100000 || reason.chars().count() > 1000 {
            return Err("说明过长".into());
        }
        self.transaction(|s| {let mut run=s.get_run(id)?;
            if text(&run,"state")=="withdrawn"{return Err("此事项已由配置更新撤销".into());} if text(&run,"state")==state{return Ok(());}
            if state=="doing"&&text(&run["config"],"type")!="task"{return Err("检查清单没有进行中列".into());}
            let reopening=["completed","skipped"].contains(&text(&run,"state"))&&["pending","doing"].contains(&state);
            run["state"]=json!(state); if run["startedAt"].is_null(){run["startedAt"]=json!(s.now());} run["changedAt"]=json!(s.now()); run["completedAt"]=if state=="completed"{json!(s.now())}else{Value::Null}; run["skipReason"]=json!(if state=="skipped"{reason}else{""}); s.put_run(&run)?;
            if ["completed","skipped"].contains(&state)||reopening{s.db.execute("UPDATE reminders SET status='cancelled' WHERE run_id=?",[id]).map_err(error)?;}
            if !result.trim().is_empty(){s.put_log(json!({"body":result,"date":s.day(),"projectId":run["config"]["project_id"],"runId":id}))?;} Ok(())
        })
    }
    pub fn edit_run(&mut self, id: &str, title: &str, body: &str) -> Result<()> {
        if title.trim().is_empty()
            || title.trim().chars().count() > 200
            || body.chars().count() > 100000
        {
            return Err("事项标题或说明无效".into());
        }
        self.transaction(|s| {
            let mut run = s.get_run(id)?;
            run["config"]["title"] = json!(title.trim());
            run["config"]["content_markdown"] = json!(body);
            run["manual"] = json!(true);
            run["changedAt"] = json!(s.now());
            s.put_run(&run)
        })
    }
    pub(crate) fn put_log(&mut self, input: Value) -> Result<()> {
        let mut log = crate::validation::validate("log", input)?;
        self.project_exists(&log["projectId"])?;
        let old = self
            .entities("logs")?
            .into_iter()
            .find(|v| v["id"] == log["id"]);
        if log.get("id").is_some() && old.is_none() {
            return Err("工作流水不存在".into());
        }
        if let Some(id) = log["runId"].as_str() {
            let mut run = self.get_run(id)?;
            if run["startedAt"].is_null() {
                run["startedAt"] = json!(self.now());
            }
            self.put_run(&run)?;
        }
        if log.get("id").is_none() {
            log["id"] = json!(uuid());
        }
        log["createdAt"] = old
            .as_ref()
            .map(|v| v["createdAt"].clone())
            .unwrap_or_else(|| json!(self.now()));
        log["updatedAt"] = json!(self.now());
        self.db.execute("INSERT INTO logs(id,data,run_id,project_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,run_id=excluded.run_id,project_id=excluded.project_id",params![text(&log,"id"),log.to_string(),sql_nullable(&log["runId"]),sql_nullable(&log["projectId"])]).map_err(error)?;
        Ok(())
    }
    pub fn save_log(&mut self, input: Value) -> Result<()> {
        self.transaction(|s| s.put_log(input))
    }
    pub fn save_note(&mut self, input: Value) -> Result<()> {
        let mut note = crate::validation::validate("note", input)?;
        self.project_exists(&note["projectId"])?;
        let old = self
            .entities("notes")?
            .into_iter()
            .find(|v| v["id"] == note["id"]);
        if note.get("id").is_some() && old.is_none() {
            return Err("笔记不存在".into());
        }
        if note.get("id").is_none() {
            note["id"] = json!(uuid());
        }
        note["createdAt"] = old
            .as_ref()
            .map(|v| v["createdAt"].clone())
            .unwrap_or_else(|| json!(self.now()));
        note["updatedAt"] = json!(self.now());
        self.transaction(|s|{s.db.execute("INSERT INTO notes(id,data,project_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,project_id=excluded.project_id",params![text(&note,"id"),note.to_string(),sql_nullable(&note["projectId"])]).map_err(error)?;Ok(())})
    }
    pub fn delete_record(&mut self, table: &str, id: &str) -> Result<()> {
        if !["notes", "logs"].contains(&table) {
            return Err("无效记录类型".into());
        }
        self.transaction(|s| {
            s.db.execute(&format!("DELETE FROM {table} WHERE id=?"), [id])
                .map_err(error)?;
            Ok(())
        })
    }
    pub fn settings(&self) -> Result<Value> {
        let raw: String = self
            .db
            .query_row("SELECT value FROM meta WHERE key='settings'", [], |r| {
                r.get(0)
            })
            .map_err(error)?;
        crate::validation::validate("settings", serde_json::from_str(&raw).map_err(error)?)
    }
    pub fn save_settings(&mut self, input: Value) -> Result<()> {
        let settings = crate::validation::validate("settings", input)?;
        self.transaction(|s| {
            s.db.execute(
                "UPDATE meta SET value=? WHERE key='settings'",
                [settings.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
    }
    pub fn reminders(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT run_id,due_at,status,snoozed FROM reminders")
            .map_err(error)?;
        let rows=stmt.query_map([],|r|Ok(json!({"runId":r.get::<_,String>(0)?,"dueAt":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"snoozed":r.get::<_,bool>(3)?}))).map_err(error)?;
        rows.map(|r| r.map_err(error)).collect()
    }
    pub fn due_reminders(&self) -> Result<Vec<Value>> {
        let active: HashSet<String> = self
            .templates()?
            .iter()
            .filter(|t| !boolean(t, "paused") && !boolean(t, "archived"))
            .map(|t| text(t, "id").to_string())
            .collect();
        let mut due = Vec::new();
        for reminder in self.reminders()? {
            if text(&reminder, "status") != "pending"
                || text(&reminder, "dueAt") > self.now().as_str()
            {
                continue;
            }
            let run = self.get_run(text(&reminder, "runId"))?;
            if pending(&run)
                && (text(&run, "date") == self.day() || boolean(&reminder, "snoozed"))
                && active.contains(text(&run, "templateId"))
            {
                due.push(run);
            }
        }
        Ok(due)
    }
    pub fn mark_shown(&mut self, ids: &[String]) -> Result<()> {
        self.update_reminders(ids, "pending", "shown")
    }
    pub fn dismiss(&mut self, ids: &[String]) -> Result<()> {
        self.update_reminders(ids, "shown", "dismissed")
    }
    fn update_reminders(&mut self, ids: &[String], from: &str, to: &str) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        self.transaction(|s| {
            for id in ids {
                s.db.execute(
                    "UPDATE reminders SET status=? WHERE run_id=? AND status=?",
                    params![to, id, from],
                )
                .map_err(error)?;
            }
            Ok(())
        })
    }
    pub fn snooze(&mut self, id: &str) -> Result<()> {
        self.transaction(|s|{let mut run=s.get_run(id)?;let active=s.templates()?.iter().any(|t|t["id"]==run["templateId"]&&!boolean(t,"paused")&&!boolean(t,"archived"));
            if !pending(&run)||!active{return Err("此事项当前无法稍后提醒".into());}
            run["manual"]=json!(true);s.put_run(&run)?;
            let due=(s.clock.unwrap_or_else(Utc::now)+Duration::minutes(run["config"]["reminder"]["snooze_minutes"].as_i64().unwrap_or(10))).to_rfc3339_opts(SecondsFormat::Millis,true);
            s.db.execute("INSERT INTO reminders(run_id,due_at,status,snoozed) VALUES(?,?,'pending',1) ON CONFLICT(run_id) DO UPDATE SET due_at=excluded.due_at,status='pending',snoozed=1",params![id,due]).map_err(error)?;Ok(())})
    }
    pub fn widget_preferences(&self) -> Result<Value> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM meta WHERE key='widget_preferences'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        crate::validation::validate(
            "widget",
            match raw {
                Some(v) => serde_json::from_str(&v).map_err(error)?,
                None => json!({}),
            },
        )
    }
    pub fn save_widget_preferences(&mut self, input: Value) -> Result<()> {
        let parsed = crate::validation::validate("widget", input)?;
        self.db.execute("INSERT INTO meta(key,value) VALUES('widget_preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[parsed.to_string()]).map_err(error)?;
        Ok(())
    }
    pub fn widget_snapshot(&mut self) -> Result<Value> {
        self.ensure_today()?;
        let day = self.day();
        let now = self.now();
        let runs = self.runs()?;
        let active: Vec<Value> = self
            .templates()?
            .into_iter()
            .filter(|t| !boolean(t, "paused") && !boolean(t, "archived"))
            .collect();
        let pending_runs: Vec<&Value> = runs
            .iter()
            .filter(|r| pending(r) && active.iter().any(|t| t["id"] == r["templateId"]))
            .collect();
        let mut upcoming = Vec::new();
        for reminder in self.reminders()? {
            let Some(run) = pending_runs.iter().find(|r| r["id"] == reminder["runId"]) else {
                continue;
            };
            if text(&reminder, "status") != "pending"
                || (text(&reminder, "dueAt") < now.as_str()
                    && text(run, "date") != day
                    && !boolean(&reminder, "snoozed"))
            {
                continue;
            }
            upcoming.push(json!({"id":run["id"],"runId":run["id"],"title":run["config"]["title"],"dueAt":reminder["dueAt"]}));
        }
        for template in &active {
            let config = &template["config"];
            let schedule = &config["schedule"];
            if !boolean(&config["reminder"], "popup") || text(schedule, "time").is_empty() {
                continue;
            }
            let once = text(schedule, "frequency") == "once";
            let first = if once {
                text(schedule, "date")
            } else {
                std::cmp::max(text(schedule, "start_date"), &day)
            };
            let start = parse_date(first)?;
            let mut projected = 0;
            for offset in 0..if once { 1 } else { 15 } {
                let date = (start + Duration::days(offset))
                    .format("%Y-%m-%d")
                    .to_string();
                if !matches(config, &date)
                    || runs
                        .iter()
                        .any(|r| r["templateId"] == template["id"] && text(r, "date") == date)
                {
                    continue;
                }
                let due = at_time(&date, text(schedule, "time"))?;
                if due < now {
                    continue;
                }
                upcoming.push(json!({"id":format!("scheduled:{}:{date}",text(template,"id")),"title":config["title"],"dueAt":due}));
                projected += 1;
                if projected == 2 {
                    break;
                }
            }
        }
        upcoming.sort_by(|a, b| {
            text(a, "dueAt")
                .cmp(text(b, "dueAt"))
                .then(text(a, "id").cmp(text(b, "id")))
        });
        upcoming.truncate(2);
        let mut checks: Vec<Value> = pending_runs
            .into_iter()
            .filter(|r| text(r, "date") == day && text(&r["config"], "type") == "checklist")
            .cloned()
            .collect();
        checks.sort_by(|a, b| {
            a["config"]["schedule"]["time"]
                .as_str()
                .unwrap_or("99:99")
                .cmp(b["config"]["schedule"]["time"].as_str().unwrap_or("99:99"))
                .then(text(a, "id").cmp(text(b, "id")))
        });
        Ok(
            json!({"today":day,"checklists":checks,"upcoming":upcoming,"pinned":self.widget_preferences()?["pinned"]}),
        )
    }
    pub fn report(&self, query: Value) -> Result<Value> {
        let from = text(&query, "from");
        let to = text(&query, "to");
        parse_date(from)?;
        parse_date(to)?;
        if to < from {
            return Err("结束日期不能早于开始日期".into());
        }
        let range = |date: &str| date >= from && date <= to;
        let logs: Vec<Value> = self
            .entities("logs")?
            .into_iter()
            .filter(|l| range(text(l, "date")))
            .collect();
        let mut selected = Vec::new();
        for run in self.runs()? {
            let complete = run["completedAt"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|d| china_day(d.with_timezone(&Utc)));
            if (text(&run, "state") == "completed" && complete.as_ref().is_some_and(|d| range(d)))
                || (boolean(&query, "includePending") && pending(&run) && range(text(&run, "date")))
            {
                selected.push((run, complete));
            }
        }
        let mut entries = Vec::new();
        for (run, date) in &selected {
            let body = logs
                .iter()
                .filter(|l| l["runId"] == run["id"])
                .map(|l| format!("{}：{}", text(l, "date"), text(l, "body")))
                .collect::<Vec<_>>()
                .join("\n\n");
            entries.push(json!({"id":format!("run:{}",text(run,"id")),"date":date.as_deref().unwrap_or(text(run,"date")),"projectId":run["config"]["project_id"],"title":run["config"]["title"],"body":body,"kind":if text(run,"state")=="completed"{"completed"}else{"pending"}}));
        }
        for log in logs {
            if !selected.iter().any(|(r, _)| r["id"] == log["runId"]) {
                entries.push(json!({"id":format!("log:{}",text(&log,"id")),"date":log["date"],"projectId":log["projectId"],"title":"工作记录","body":log["body"],"kind":"log"}));
            }
        }
        entries.sort_by(|a, b| text(a, "date").cmp(text(b, "date")));
        Ok(json!(entries))
    }
    pub fn report_markdown(&self, entries: &Value, grouping: &str) -> Result<String> {
        if !["date", "project"].contains(&grouping) {
            return Err("无效分组".into());
        }
        let entries = entries.as_array().ok_or("汇报条目格式无效")?;
        if entries.len() > 50000 {
            return Err("汇报条目过多".into());
        }
        let projects = self.entities("projects")?;
        let project_name = |e: &Value| {
            projects
                .iter()
                .find(|p| p["id"] == e["projectId"])
                .map(|p| text(p, "name"))
                .unwrap_or("未关联项目")
        };
        let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
        for entry in entries {
            let key = if grouping == "date" {
                text(entry, "date")
            } else {
                project_name(entry)
            }
            .to_string();
            if let Some((_, rows)) = groups.iter_mut().find(|(k, _)| k == &key) {
                rows.push(entry);
            } else {
                groups.push((key, vec![entry]));
            }
        }
        let mut result = String::from("# 工作汇报素材\n\n");
        for (index, (group, rows)) in groups.iter().enumerate() {
            if index > 0 {
                result.push('\n');
            }
            result.push_str(&format!("## {group}\n\n"));
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    result.push('\n');
                }
                let kind = match text(row, "kind") {
                    "completed" => "已完成",
                    "pending" => "待跟进",
                    "log" => "工作流水",
                    _ => return Err("无效汇报状态".into()),
                };
                let body = if text(row, "body").is_empty() {
                    if text(row, "kind") == "completed" {
                        "已记录完成。"
                    } else {
                        "待跟进。"
                    }
                } else {
                    text(row, "body")
                };
                result.push_str(&format!(
                    "### {}\n\n{} · {} · {kind}\n\n{body}\n",
                    text(row, "title"),
                    text(row, "date"),
                    project_name(row)
                ));
            }
        }
        Ok(result)
    }
    pub fn dispatch(&mut self, channel: &str, args: Vec<Value>) -> Result<Value> {
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let string = |index: usize| {
            args.get(index)
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少字符串参数".to_string())
        };
        let flag = |index: usize| {
            args.get(index)
                .and_then(Value::as_bool)
                .ok_or_else(|| "缺少布尔参数".to_string())
        };
        match channel {
            "snapshot" => return self.snapshot(),
            "widget.get" => return self.widget_snapshot(),
            "items.save" => self.save_item(
                arg(0),
                args.get(1).and_then(Value::as_str).map(str::to_string),
            )?,
            "items.mode" => self.set_mode(string(0)?, flag(1)?, flag(2)?)?,
            "items.check" => self.check(string(0)?, string(1)?, flag(2)?)?,
            "items.state" => self.state(
                string(0)?,
                string(1)?,
                args.get(2).and_then(Value::as_str).unwrap_or(""),
                args.get(3).and_then(Value::as_str).unwrap_or(""),
            )?,
            "items.edit" => self.edit_run(string(0)?, string(1)?, string(2)?)?,
            "logs.save" => self.save_log(arg(0))?,
            "logs.delete" => self.delete_record("logs", string(0)?)?,
            "notes.save" => self.save_note(arg(0))?,
            "notes.delete" => self.delete_record("notes", string(0)?)?,
            "settings.save" => self.save_settings(arg(0))?,
            "reports.preview" => return self.report(arg(0)),
            "reports.markdown" => {
                return self.report_markdown(&arg(0), string(1)?).map(Value::String)
            }
            "reminders.snooze" => self.snooze(string(0)?)?,
            "reminders.dismiss" => {
                let ids: Vec<String> = serde_json::from_value(arg(0)).map_err(error)?;
                self.dismiss(&ids)?;
            }
            _ => return self.exchange(channel, args),
        }
        Ok(Value::Null)
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

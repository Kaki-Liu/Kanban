use crate::{
    store::{editable, text, Store},
    validation::validate,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[cfg(test)]
#[path = "exchange_tests.rs"]
mod tests;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn arg(args: &[Value], n: usize) -> Value {
    args.get(n).cloned().unwrap_or(Value::Null)
}
fn string(args: &[Value], n: usize) -> Result<String, String> {
    args.get(n)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or("参数需要字符串".into())
}
fn started(t: &Value) -> bool {
    t["hasStarted"] == true
        || text(t, "state") != "todo"
        || !text(t, "evidence").trim().is_empty()
        || !text(t, "blocker").trim().is_empty()
        || text(&t["handoff"], "status") != "draft"
}
fn mark_started(w: &mut Value, previous: Option<&Value>) {
    let previous: HashMap<&str, &Value> = previous
        .and_then(|v| v["tasks"].as_array())
        .map(|a| a.iter().map(|t| (text(t, "id"), t)).collect())
        .unwrap_or_default();
    for t in w["tasks"].as_array_mut().unwrap() {
        t["hasStarted"] = json!(
            started(t)
                || previous
                    .get(text(t, "id"))
                    .map(|p| started(p))
                    .unwrap_or(false)
        );
    }
}
fn merge_workflow(current: &Value, incoming: &Value) -> Result<(Value, usize), String> {
    let mut out = incoming.clone();
    let mut count = 0;
    for key in ["tasks", "milestones", "decisions", "participants"] {
        let mut entries = current[key].as_array().cloned().unwrap_or_default();
        for next in incoming[key].as_array().unwrap() {
            let index = entries.iter().position(|v| v["id"] == next["id"]);
            let protect = index
                .map(|i| match key {
                    "tasks" => started(&entries[i]),
                    "milestones" => entries[i]["state"] == "completed",
                    "decisions" => entries[i]["status"] == "confirmed",
                    _ => false,
                })
                .unwrap_or(false);
            if protect {
                count += 1;
                continue;
            }
            let mut next = next.clone();
            match key {
                "tasks" => {
                    if next["state"] == "done" {
                        next["state"] = json!("review");
                    }
                    if ["accepted", "received"].contains(&text(&next["handoff"], "status")) {
                        next["handoff"]["status"] = json!("submitted");
                    }
                }
                "milestones" => {
                    if next["state"] == "completed" {
                        next["state"] = json!("active");
                    }
                }
                "decisions" => {
                    next["status"] = json!("pending");
                }
                _ => {}
            }
            if let Some(i) = index {
                entries[i] = next;
            } else {
                entries.push(next);
            }
        }
        out[key] = json!(entries);
    }
    Ok((validate("workflow", out)?, count))
}
fn change_text(v: Option<&Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}
fn changes(before: Option<&Value>, after: Option<&Value>, field: &str, out: &mut Vec<Value>) {
    if before == after {
        return;
    }
    if let Some(Value::Array(next)) = after {
        let identified = |v: &Value| v["id"].is_string();
        if next.iter().all(identified)
            && (!next.is_empty()
                || before
                    .and_then(Value::as_array)
                    .map(|a| a.iter().all(identified))
                    .unwrap_or(false))
        {
            let mut old: HashMap<&str, &Value> = before
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|v| (text(v, "id"), v)).collect())
                .unwrap_or_default();
            for v in next {
                let id = text(v, "id");
                changes(old.remove(id), Some(v), &format!("{field}[{id}]"), out);
            }
            let mut missing: Vec<_> = old.into_iter().collect();
            missing.sort_by_key(|(id, _)| *id);
            for (id, v) in missing {
                changes(Some(v), None, &format!("{field}[{id}]"), out);
            }
            return;
        }
    }
    if let Some(Value::Object(next)) = after {
        let mut keys: Vec<&str> = next.keys().map(String::as_str).collect();
        if let Some(old) = before.and_then(Value::as_object) {
            keys.extend(old.keys().map(String::as_str));
        }
        keys.sort();
        keys.dedup();
        for key in keys {
            changes(
                before.and_then(|v| v.get(key)),
                next.get(key),
                &format!("{field}.{key}"),
                out,
            );
        }
        return;
    }
    out.push(json!({"field":field,"before":change_text(before),"after":change_text(after)}));
}
impl Store {
    pub fn exchange(&mut self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        match channel {
            "projects.save" => {
                self.save_project(arg(&args, 0))?;
                Ok(Value::Null)
            }
            "projects.workflow" => {
                self.save_workflow(
                    &string(&args, 0)?,
                    arg(&args, 1),
                    arg(&args, 2).as_i64().ok_or("数据版本无效")?,
                )?;
                Ok(Value::Null)
            }
            "projects.config.preview" => {
                self.preview_project_config(&string(&args, 0)?, args.get(1).and_then(Value::as_str))
            }
            "projects.config.commit" => Ok(json!(self.commit_project_config(&string(&args, 0)?)?)),
            "projects.config.export" => Ok(json!(
                self.export_project_config(args.first().and_then(Value::as_str))?
            )),
            "imports.preview" => self.preview_import(&string(&args, 0)?),
            "imports.commit" => {
                self.commit_import(&string(&args, 0)?)?;
                Ok(Value::Null)
            }
            "imports.export" => Ok(json!(self.export_config()?)),
            "backup.create" => {
                self.create_backup(Path::new(&string(&args, 0)?))?;
                Ok(Value::Null)
            }
            "backup.preview" => self.preview_backup(Path::new(&string(&args, 0)?)),
            "backup.restore" => {
                self.restore_backup(&string(&args, 0)?)?;
                Ok(Value::Null)
            }
            _ => Err(format!("未知操作：{channel}")),
        }
    }
    fn project(&self, id: &str) -> Result<Option<Value>, String> {
        self.db
            .query_row("SELECT data FROM projects WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(err)?
            .map(|s| serde_json::from_str(&s).map_err(err))
            .transpose()
    }
    fn put_project(&self, p: &Value) -> Result<(), String> {
        self.db.execute("INSERT INTO projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![text(p,"id"),p.to_string()]).map_err(err)?;
        Ok(())
    }
    pub fn save_project(&mut self, input: Value) -> Result<(), String> {
        let mut p = validate("project", input)?;
        self.transaction(move |s| {
            let log = p
                .as_object_mut()
                .unwrap()
                .remove("logUpdate")
                .unwrap_or(json!(false))
                == true;
            if p.get("id").is_none() {
                p["id"] = json!(Uuid::new_v4().to_string());
            }
            let old = s.project(text(&p, "id"))?;
            if let Some(old) = &old {
                if p.get("workflow").is_some() && p.get("workflow") != old.get("workflow") {
                    return Err("开发流程已变化，请在开发流程页面刷新后保存".into());
                }
                p.as_object_mut().unwrap().remove("workflow");
                if let Some(w) = old.get("workflow") {
                    p["workflow"] = w.clone();
                }
            } else if let Some(w) = p.get_mut("workflow") {
                mark_started(w, None);
            }
            s.put_project(&p)?;
            if old.is_none() {
                if let Some(w) = p.get("workflow") {
                    s.record_completions(text(&p, "id"), w, None)?;
                }
            }
            if log && !text(&p, "update").trim().is_empty() {
                s.put_log(json!({"body":p["update"],"date":s.day(),"projectId":p["id"]}))?;
            }
            Ok(())
        })
    }
    pub fn save_workflow(&mut self, id: &str, input: Value, revision: i64) -> Result<(), String> {
        let mut w = validate("workflow", input)?;
        self.transaction(|s| {
            if s.revision()? != revision {
                return Err("数据已变化，请刷新后重新检查草稿再保存".into());
            }
            let mut p = s.project(id)?.ok_or("项目不存在")?;
            let old = p.get("workflow").cloned();
            mark_started(&mut w, old.as_ref());
            p["workflow"] = w.clone();
            s.put_project(&p)?;
            s.record_completions(id, &w, old.as_ref())
        })
    }
    fn record_completions(
        &self,
        id: &str,
        w: &Value,
        previous: Option<&Value>,
    ) -> Result<(), String> {
        for task in w["tasks"].as_array().unwrap() {
            if task["state"] != "done" {
                continue;
            }
            let old = previous
                .and_then(|v| v["tasks"].as_array())
                .and_then(|a| a.iter().find(|t| t["id"] == task["id"]));
            if old
                .map(|o| {
                    o["state"] == "done"
                        && o["title"] == task["title"]
                        && o["evidence"] == task["evidence"]
                })
                .unwrap_or(false)
            {
                continue;
            }
            let log_id = format!(
                "workflow-{:x}",
                Sha256::digest(json!([id, task["id"]]).to_string().as_bytes())
            );
            let old_log: Option<String> = self
                .db
                .query_row("SELECT data FROM logs WHERE id=?", [&log_id], |r| r.get(0))
                .optional()
                .map_err(err)?;
            let old_log: Value = old_log
                .map(|s| serde_json::from_str(&s))
                .transpose()
                .map_err(err)?
                .unwrap_or(Value::Null);
            let date = if old.map(|o| o["state"] == "done").unwrap_or(false) && old_log.is_object()
            {
                old_log["date"].clone()
            } else {
                json!(self.day())
            };
            let log = json!({"id":log_id,"body":format!("完成开发任务：{}\n\n{}",text(task,"title"),text(task,"evidence")),"date":date,"projectId":id,"runId":null,"createdAt":old_log.get("createdAt").cloned().unwrap_or(json!(self.now())),"updatedAt":self.now()});
            self.db.execute("INSERT INTO logs(id,data,run_id,project_id) VALUES(?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![log_id,log.to_string(),id]).map_err(err)?;
        }
        Ok(())
    }
    fn config_result(
        &self,
        config: &Value,
        id: &str,
    ) -> Result<(Value, Option<Value>, usize), String> {
        let old = self.project(id)?;
        let mut p = config["project"].clone();
        p["id"] = json!(id);
        let mut count = 0;
        if let Some(w) = p.get("workflow") {
            let current = old
                .as_ref()
                .and_then(|o| o.get("workflow"))
                .cloned()
                .unwrap_or(validate("workflow", json!({"mode":w["mode"]}))?);
            let (mut merged, n) = merge_workflow(&current, w)?;
            count = n;
            mark_started(&mut merged, old.as_ref().and_then(|o| o.get("workflow")));
            p["workflow"] = merged;
        } else if let Some(w) = old.as_ref().and_then(|o| o.get("workflow")) {
            p["workflow"] = w.clone();
        }
        Ok((p, old, count))
    }
    pub fn parse_project_config(text: &str) -> Result<Value, String> {
        if text.len() > 2_000_000 {
            return Err("项目配置不能超过 2 MB".into());
        }
        validate(
            "projectConfig",
            serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(err)?,
        )
    }
    pub fn preview_project_config(
        &mut self,
        text: &str,
        target: Option<&str>,
    ) -> Result<Value, String> {
        let config = Self::parse_project_config(text)?;
        if let Some(target) = target {
            self.project_exists(&json!(target))?;
            if let Some(id) = config["project"].get("id") {
                if id != target {
                    return Err("配置中的项目 ID 与当前项目不匹配，请从当前项目导出后修改。".into());
                }
            }
        }
        let id = target
            .map(str::to_string)
            .or_else(|| config["project"]["id"].as_str().map(str::to_string))
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let (p, old, count) = self.config_result(&config, &id)?;
        let token = Uuid::new_v4().to_string();
        let mut diff = Vec::new();
        changes(old.as_ref(), Some(&p), "project", &mut diff);
        self.previews.retain(|_, v| v["kind"] != "project");
        self.previews.insert(
            token.clone(),
            json!({"kind":"project","config":config,"projectId":id,"revision":self.revision()?}),
        );
        Ok(
            json!({"token":token,"projectId":id,"name":p["name"],"action":if old.is_some(){"update"}else{"create"},"changes":diff,"protectedCount":count}),
        )
    }
    pub fn commit_project_config(&mut self, token: &str) -> Result<String, String> {
        let p = self
            .previews
            .get(token)
            .cloned()
            .ok_or("数据已变化或预览已失效，请重新校验并预览。")?;
        if p["kind"] != "project" || p["revision"] != self.revision()? {
            return Err("数据已变化或预览已失效，请重新校验并预览。".into());
        }
        let id = text(&p, "projectId").to_string();
        self.transaction(|s| {
            if p["revision"] != s.revision()? {
                return Err("数据已变化，请重新预览".into());
            }
            let c = validate("projectConfig", p["config"].clone())?;
            let (project, previous, _) = s.config_result(&c, &id)?;
            s.put_project(&project)?;
            if let Some(w) = project.get("workflow") {
                s.record_completions(&id, w, previous.as_ref().and_then(|v| v.get("workflow")))?;
            }
            Ok(())
        })?;
        self.previews.remove(token);
        Ok(id)
    }
    pub fn export_project_config(&self, id: Option<&str>) -> Result<String, String> {
        match id {
            None => Ok(include_str!("../schemas/project-template.json").into()),
            Some(id) => {
                let p = self.project(id)?.ok_or("项目不存在")?;
                serde_json::to_string_pretty(&validate(
                    "projectConfig",
                    json!({"schema_version":1,"kind":"kanban-project","project":p}),
                )?)
                .map_err(err)
            }
        }
    }
    pub fn preview_import(&mut self, source: &str) -> Result<Value, String> {
        if source.len() > 5_000_000 {
            return Err("配置过大".into());
        }
        let config = validate("import", serde_json::from_str(source).map_err(err)?)?;
        let templates = self.templates()?;
        let runs = self.runs()?;
        let mut changes = Vec::new();
        for (i, c) in config["items"].as_array().unwrap().iter().enumerate() {
            self.project_exists(&c["project_id"])
                .map_err(|e| format!("items.{i}.project_id: {e}"))?;
            let old = templates.iter().find(|t| t["id"] == c["id"]);
            let fields: Vec<String> = old
                .map(|old| {
                    c.as_object()
                        .unwrap()
                        .keys()
                        .filter(|k| old["config"].get(*k) != c.get(*k))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let affected: Vec<_> = runs
                .iter()
                .filter(|r| r["templateId"] == c["id"] && text(r, "date") >= self.day().as_str())
                .collect();
            let mut warnings = Vec::new();
            if c["schedule"]["frequency"] == "once"
                && text(&c["schedule"], "date") < self.day().as_str()
            {
                warnings.push("过去日期：显示逾期，不补弹提醒".to_string());
            }
            if old
                .map(|o| o["paused"] == true || o["archived"] == true)
                .unwrap_or(false)
            {
                warnings.push("配置仍处于暂停或归档状态".into());
            }
            for f in &fields {
                if c[f].is_null() || c[f] == "" {
                    warnings.push(format!("{f} 将被清空"));
                }
            }
            changes.push(json!({"id":c["id"],"title":c["title"],"action":if old.is_none(){"add"}else if fields.is_empty(){"unchanged"}else{"update"},"fields":fields,"protectedCount":affected.iter().filter(|r|!editable(r)).count(),"syncCount":affected.iter().filter(|r|editable(r)).count(),"warnings":warnings}));
        }
        let token = Uuid::new_v4().to_string();
        self.previews.retain(|_, v| v["kind"] != "items");
        self.previews.insert(
            token.clone(),
            json!({"kind":"items","config":config,"revision":self.revision()?,"day":self.day()}),
        );
        Ok(json!({"token":token,"changes":changes}))
    }
    pub fn commit_import(&mut self, token: &str) -> Result<(), String> {
        let p = self
            .previews
            .get(token)
            .cloned()
            .ok_or("预览已过期，请重新预览")?;
        if p["kind"] != "items" || p["revision"] != self.revision()? || p["day"] != self.day() {
            return Err("预览已过期，数据或日期发生变化，请重新预览。".into());
        }
        let configs = p["config"]["items"]
            .as_array()
            .ok_or("配置损坏")?
            .iter()
            .map(|c| self.validate_config(c.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        self.transaction(|s| {
            for c in configs {
                s.apply(c, None)?;
            }
            Ok(())
        })?;
        self.previews.retain(|_, v| v["kind"] != "items");
        Ok(())
    }
    pub fn export_config(&self) -> Result<String, String> {
        serde_json::to_string_pretty(&json!({"schema_version":1,"items":self.templates()?.iter().map(|t|t["config"].clone()).collect::<Vec<_>>()})).map_err(err)
    }
    pub fn prepare_version(&mut self, version: &str) -> Result<(), String> {
        if version.len() > 100
            || !version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ['.', '-', '+'].contains(&c))
            || version
                .split(['-', '+'])
                .next()
                .unwrap_or("")
                .split('.')
                .count()
                != 3
            || version
                .split(['-', '+'])
                .next()
                .unwrap_or("")
                .split('.')
                .any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()))
        {
            return Err("应用版本无效".into());
        }
        let old: Option<String> = self
            .db
            .query_row("SELECT value FROM meta WHERE key='app_version'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)?;
        if old.as_deref() == Some(version) {
            return Ok(());
        }
        let mut has_data = false;
        for table in ["projects", "templates", "logs", "notes"] {
            if self
                .db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(err)?
                > 0
            {
                has_data = true;
                break;
            }
        }
        if has_data {
            let dir = self.path.parent().ok_or("数据目录不存在")?.join("backups");
            fs::create_dir_all(&dir).map_err(err)?;
            self.create_backup(&dir.join(format!(
                "before-upgrade-{version}-{}.kanban-backup",
                Uuid::new_v4()
            )))?;
        }
        self.transaction(|s|{s.db.execute("INSERT INTO meta(key,value) VALUES('app_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[version]).map_err(err)?;Ok(())})
    }
    pub fn create_backup(&self, path: &Path) -> Result<(), String> {
        fn canonical(p: &Path) -> Result<PathBuf, String> {
            if p.exists() {
                fs::canonicalize(p).map_err(err)
            } else {
                std::path::absolute(p).map_err(err)
            }
        }
        if canonical(path)?.to_string_lossy().to_lowercase()
            == canonical(&self.path)?.to_string_lossy().to_lowercase()
        {
            return Err("备份不能覆盖当前数据库".into());
        }
        let mut target = Connection::open(path).map_err(err)?;
        {
            let backup = rusqlite::backup::Backup::new(&self.db, &mut target).map_err(err)?;
            backup
                .run_to_completion(100, std::time::Duration::from_millis(10), None)
                .map_err(err)?;
        }
        target.execute("INSERT INTO meta(key,value) VALUES('backup_created',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[self.now()]).map_err(err)?;
        target
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
            .map_err(err)?;
        Ok(())
    }
    pub fn preview_backup(&mut self, path: &Path) -> Result<Value, String> {
        let (created, counts, _) = inspect_backup(path)?;
        let token = Uuid::new_v4().to_string();
        self.previews.retain(|_, v| v["kind"] != "restore");
        self.previews.insert(token.clone(),json!({"kind":"restore","path":path.to_string_lossy(),"hash":file_hash(path)?,"revision":self.revision()?}));
        Ok(json!({"token":token,"createdAt":created,"counts":counts}))
    }
    pub fn restore_backup(&mut self, token: &str) -> Result<(), String> {
        let p = self
            .previews
            .get(token)
            .cloned()
            .ok_or("恢复预览已过期，请重新选择备份")?;
        if p["kind"] != "restore" || p["revision"] != self.revision()? {
            return Err("恢复预览已过期，请重新选择备份".into());
        }
        let path = Path::new(text(&p, "path"));
        if p["hash"] != file_hash(path)? {
            return Err("备份文件已变化，请重新预览".into());
        }
        let (_, _, data) = inspect_backup(path)?;
        let revision = self.revision()?;
        let dir = self.path.parent().ok_or("数据目录不存在")?.join("backups");
        fs::create_dir_all(&dir).map_err(err)?;
        self.create_backup(&dir.join(format!("before-restore-{}.kanban-backup", Uuid::new_v4())))?;
        self.transaction(|s| {
            for table in [
                "logs",
                "reminders",
                "runs",
                "templates",
                "notes",
                "projects",
                "meta",
            ] {
                s.db.execute(&format!("DELETE FROM {table}"), [])
                    .map_err(err)?;
            }
            for (table, columns) in TABLES {
                let sql = format!(
                    "INSERT INTO {table}({}) VALUES({})",
                    columns.join(","),
                    vec!["?"; columns.len()].join(",")
                );
                for row in &data[*table] {
                    let values: Vec<rusqlite::types::Value> = columns
                        .iter()
                        .map(|col| match &row[*col] {
                            Value::Null => rusqlite::types::Value::Null,
                            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                            Value::Number(n) => {
                                rusqlite::types::Value::Integer(n.as_i64().unwrap_or_default())
                            }
                            _ => rusqlite::types::Value::Null,
                        })
                        .collect();
                    s.db.execute(&sql, rusqlite::params_from_iter(values))
                        .map_err(err)?;
                }
            }
            s.db.execute(
                "UPDATE meta SET value=? WHERE key='revision'",
                [revision.to_string()],
            )
            .map_err(err)?;
            if s.db
                .prepare("PRAGMA foreign_key_check")
                .map_err(err)?
                .exists([])
                .map_err(err)?
            {
                return Err("恢复后关联检查失败".into());
            }
            Ok(())
        })?;
        self.previews.clear();
        Ok(())
    }
}

const TABLES: &[(&str, &[&str])] = &[
    ("projects", &["id", "data"]),
    ("notes", &["id", "data", "project_id"]),
    (
        "templates",
        &["id", "config", "paused", "archived", "note_id"],
    ),
    ("runs", &["id", "template_id", "day", "state", "data"]),
    ("reminders", &["run_id", "due_at", "status", "snoozed"]),
    ("logs", &["id", "data", "run_id", "project_id"]),
    ("meta", &["key", "value"]),
];
fn file_hash(path: &Path) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(err)?)
    ))
}
fn inspect_backup(path: &Path) -> Result<(String, Value, HashMap<String, Vec<Value>>), String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN;")
        .map_err(err)?;
    let app: i64 = db
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(err)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    if app != 1262571074 || version != 1 {
        return Err("备份格式或版本不兼容".into());
    }
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(err)?;
    if integrity != "ok"
        || db
            .prepare("PRAGMA foreign_key_check")
            .map_err(err)?
            .exists([])
            .map_err(err)?
    {
        return Err("备份完整性检查失败".into());
    }
    let mut query=db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger')").map_err(err)?;
    let objects = query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    if objects.len() != TABLES.len()
        || objects
            .iter()
            .any(|(name, kind)| kind != "table" || !TABLES.iter().any(|(table, _)| table == name))
    {
        return Err("备份含不支持的表结构".into());
    }
    let mut data: HashMap<String, Vec<Value>> = HashMap::new();
    let mut counts = json!({});
    for (table, columns) in TABLES {
        let mut stmt = db
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(err)?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        if names.iter().map(String::as_str).collect::<Vec<_>>() != *columns {
            return Err("备份列结构不兼容".into());
        }
        let mut stmt = db
            .prepare(&format!("SELECT {} FROM {table}", columns.join(",")))
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                let mut v = json!({});
                for (i, col) in columns.iter().enumerate() {
                    v[*col] = match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => json!(n),
                        rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        _ => Value::Null,
                    };
                }
                Ok(v)
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        counts[*table] = json!(rows.len());
        data.insert(table.to_string(), rows);
    }
    let project_ids: HashSet<&str> = data["projects"].iter().map(|p| text(p, "id")).collect();
    let has_project =
        |v: &Value| v.is_null() || v.as_str().map(|s| project_ids.contains(s)).unwrap_or(false);
    for row in &data["projects"] {
        let p = validate(
            "project",
            serde_json::from_str(text(row, "data")).map_err(err)?,
        )?;
        if p["id"] != row["id"] {
            return Err("项目标识损坏".into());
        }
    }
    for row in &data["templates"] {
        let c = validate(
            "item",
            serde_json::from_str(text(row, "config")).map_err(err)?,
        )?;
        if c["id"] != row["id"] || !has_project(&c["project_id"]) {
            return Err("配置标识或关联项目损坏".into());
        }
        if ![0, 1].contains(&row["paused"].as_i64().unwrap_or(-1))
            || ![0, 1].contains(&row["archived"].as_i64().unwrap_or(-1))
        {
            return Err("配置状态损坏".into());
        }
    }
    for table in ["notes", "logs"] {
        for row in &data[table] {
            let v: Value = serde_json::from_str(text(row, "data")).map_err(err)?;
            let fields = if table == "notes" {
                vec!["id", "title", "body", "projectId"]
            } else {
                vec!["id", "body", "date", "projectId", "runId"]
            };
            let mut input = json!({});
            for key in fields {
                input[key] = v[key].clone();
            }
            validate(if table == "notes" { "note" } else { "log" }, input)?;
            if v["id"] != row["id"]
                || v["projectId"] != row["project_id"]
                || (table == "logs" && v["runId"] != row["run_id"])
            {
                return Err("记录标识损坏".into());
            }
        }
    }
    for row in &data["runs"] {
        let r: Value = serde_json::from_str(text(row, "data")).map_err(err)?;
        validate("item", r["config"].clone())?;
        crate::validation::date(&r["date"], false)?;
        let valid_checks = r["checks"]
            .as_object()
            .map(|o| o.values().all(Value::is_boolean))
            .unwrap_or(false);
        if !valid_checks
            || !r["manual"].is_boolean()
            || r["id"] != row["id"]
            || r["templateId"] != row["template_id"]
            || r["date"] != row["day"]
            || r["state"] != row["state"]
            || !has_project(&r["config"]["project_id"])
            || !["pending", "doing", "completed", "skipped", "withdrawn"]
                .contains(&text(&r, "state"))
            || (r["state"] == "completed" && !r["completedAt"].is_string())
        {
            return Err("执行记录损坏".into());
        }
        for key in ["changedAt", "startedAt", "completedAt"] {
            if key != "changedAt" && r[key].is_null() {
                continue;
            }
            chrono::DateTime::parse_from_rfc3339(text(&r, key)).map_err(|_| "执行时间损坏")?;
        }
    }
    for row in &data["reminders"] {
        chrono::DateTime::parse_from_rfc3339(text(row, "due_at")).map_err(|_| "提醒时间损坏")?;
        if !["pending", "shown", "dismissed", "cancelled"].contains(&text(row, "status"))
            || ![0, 1].contains(&row["snoozed"].as_i64().unwrap_or(-1))
        {
            return Err("提醒状态损坏".into());
        }
    }
    let setting = data["meta"]
        .iter()
        .find(|r| r["key"] == "settings")
        .ok_or("备份缺少设置")?;
    validate(
        "settings",
        serde_json::from_str(text(setting, "value")).map_err(err)?,
    )?;
    if let Some(widget) = data["meta"]
        .iter()
        .find(|r| r["key"] == "widget_preferences")
    {
        validate(
            "widget",
            serde_json::from_str(text(widget, "value")).map_err(err)?,
        )?;
    }
    if !data["meta"]
        .iter()
        .any(|r| r["key"] == "revision" && text(r, "value").parse::<u64>().is_ok())
    {
        return Err("备份缺少数据版本".into());
    }
    let created = data["meta"]
        .iter()
        .find(|r| r["key"] == "backup_created")
        .map(|r| text(r, "value").to_string())
        .unwrap_or("未知".into());
    Ok((created, counts, data))
}

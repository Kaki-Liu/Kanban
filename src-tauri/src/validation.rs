use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

fn schemas() -> &'static Value {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("../schemas/contracts.json")).expect("bundled schemas")
    })
}
fn normalize(schema: &Value, value: &mut Value) {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        if let Some(branch) = branches
            .iter()
            .find(|branch| match branch["type"].as_str() {
                Some("object") => {
                    value.is_object()
                        && branch["properties"]
                            .as_object()
                            .map(|p| {
                                p.iter().all(|(k, s)| {
                                    // Optional constants such as timezone may be absent and
                                    // acquire their defaults after the union is selected.
                                    value
                                        .get(k)
                                        .map(|actual| {
                                            s.get("const").map(|c| actual == c).unwrap_or(true)
                                                && s.get("enum")
                                                    .and_then(Value::as_array)
                                                    .map(|options| options.contains(actual))
                                                    .unwrap_or(true)
                                        })
                                        .unwrap_or(true)
                                })
                            })
                            .unwrap_or(true)
                }
                Some("string") => value.is_string(),
                Some("null") => value.is_null(),
                _ => false,
            })
        {
            normalize(branch, value);
        }
    }
    if schema.get("minLength").is_some() {
        if let Some(s) = value.as_str() {
            *value = json!(s.trim());
        }
    }
    if let Some(props) = schema["properties"].as_object() {
        if let Some(object) = value.as_object_mut() {
            for (key, definition) in props {
                if !object.contains_key(key) {
                    if let Some(default) = definition.get("default") {
                        object.insert(key.clone(), default.clone());
                    }
                }
                if let Some(child) = object.get_mut(key) {
                    normalize(definition, child);
                }
            }
        }
    }
    if let Some(items) = value.as_array_mut() {
        for child in items {
            normalize(&schema["items"], child);
        }
    }
}
pub fn validate(kind: &str, mut value: Value) -> Result<Value, String> {
    let schema = &schemas()[kind];
    if schema.is_null() {
        return Err(format!("未知校验类型：{kind}"));
    }
    normalize(schema, &mut value);
    // Cache compiled validators so normal saves do not repeatedly compile schemas.
    static VALIDATORS: OnceLock<HashMap<String, jsonschema::Validator>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        schemas()
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, s)| {
                (
                    k.clone(),
                    jsonschema::validator_for(s).expect("valid bundled schema"),
                )
            })
            .collect()
    });
    let errors: Vec<String> = validators[kind]
        .iter_errors(&value)
        .take(20)
        .map(|e| format!("{}: {}", e.instance_path, e))
        .collect();
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    match kind {
        "item" => item_rules(&value)?,
        "import" => {
            unique(&value["items"], "items")?;
            for item in value["items"].as_array().unwrap() {
                item_rules(item)?;
            }
        }
        "workflow" => workflow_rules(&value)?,
        "project" => {
            if let Some(w) = value.get("workflow") {
                workflow_rules(w)?;
            }
        }
        "projectConfig" => {
            if let Some(w) = value["project"].get("workflow") {
                workflow_rules(w)?;
            }
        }
        "log" => date(&value["date"], false)?,
        _ => {}
    }
    Ok(value)
}
pub fn date(value: &Value, optional: bool) -> Result<(), String> {
    let s = value.as_str().ok_or("日期必须为字符串")?;
    if optional && s.is_empty() {
        return Ok(());
    }
    if s.len() != 10
        || chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(|d| d.format("%Y-%m-%d").to_string() != s)
            .unwrap_or(true)
    {
        return Err(format!("日期不存在：{s}"));
    }
    Ok(())
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn unique(v: &Value, path: &str) -> Result<(), String> {
    let mut ids = HashSet::new();
    for (i, item) in v.as_array().ok_or("需要列表")?.iter().enumerate() {
        if !ids.insert(text(item, "id")) {
            return Err(format!("{path}.{i}.id: id 不能重复"));
        }
    }
    Ok(())
}
fn item_rules(item: &Value) -> Result<(), String> {
    unique(&item["checklist"], "checklist")?;
    let checks = item["checklist"].as_array().unwrap();
    if (text(item, "type") == "task" && !checks.is_empty())
        || (text(item, "type") == "checklist" && checks.is_empty())
    {
        return Err("checklist: 检查清单至少需要一项，普通任务不能包含检查子项".into());
    }
    let s = &item["schedule"];
    date(
        if text(s, "frequency") == "once" {
            &s["date"]
        } else {
            &s["start_date"]
        },
        false,
    )?;
    if let Some(days) = s["weekdays"].as_array() {
        let mut seen = HashSet::new();
        if days.iter().any(|d| !seen.insert(d.to_string())) {
            return Err("schedule.weekdays: 星期不能重复".into());
        }
    }
    if item["reminder"]["popup"] == true && s.get("time").is_none() {
        return Err("schedule.time: 弹窗提醒需要时间".into());
    }
    Ok(())
}
fn workflow_rules(w: &Value) -> Result<(), String> {
    for k in ["participants", "milestones", "tasks", "decisions"] {
        unique(&w[k], k)?;
    }
    let tasks: HashMap<&str, &Value> = w["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (text(t, "id"), t))
        .collect();
    let milestones: HashSet<&str> = w["milestones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| text(t, "id"))
        .collect();
    for (i, t) in w["tasks"].as_array().unwrap().iter().enumerate() {
        let fail = |s: &str| Err(format!("tasks.{i}: {s}"));
        if !text(t, "milestoneId").is_empty() && !milestones.contains(text(t, "milestoneId")) {
            return fail("关联的里程碑不存在");
        }
        date(&t["followUpDate"], true)?;
        let mut seen = HashSet::new();
        for d in t["dependsOn"].as_array().unwrap() {
            let dep = d.as_str().unwrap();
            if !seen.insert(dep) {
                return fail("依赖不能重复");
            }
            if dep == text(t, "id") || !tasks.contains_key(dep) {
                return fail("依赖任务不存在或依赖自己");
            }
            if text(t, "state") == "done" && text(tasks[dep], "state") != "done" {
                return fail("依赖完成后才能完成此任务");
            }
        }
        let h = &t["handoff"];
        if text(t, "state") == "done" {
            if text(t, "acceptance").trim().is_empty() || text(t, "evidence").trim().is_empty() {
                return fail("完成前需要填写验收标准和验证结果");
            }
            if !text(t, "blocker").trim().is_empty() {
                return fail("请先解除阻碍再完成任务");
            }
            if !text(t, "receiver").trim().is_empty() && text(h, "status") != "accepted" {
                return fail("有接收人的任务需要交接验收通过后才能完成");
            }
        }
        if ["submitted", "received", "accepted"].contains(&text(h, "status"))
            && (text(t, "receiver").trim().is_empty() || text(h, "artifacts").trim().is_empty())
        {
            return fail("提交交接需要接收人和交付物");
        }
        if text(h, "status") == "accepted" && text(h, "verification").trim().is_empty() {
            return fail("交接验收通过需要验证结果");
        }
        if text(h, "status") == "returned" && text(h, "note").trim().is_empty() {
            return fail("退回交接需要说明");
        }
    }
    fn visit<'a>(
        id: &'a str,
        tasks: &HashMap<&'a str, &'a Value>,
        visiting: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> bool {
        if visiting.contains(id) {
            return true;
        }
        if done.contains(id) {
            return false;
        }
        visiting.insert(id);
        if let Some(t) = tasks.get(id) {
            for d in t["dependsOn"].as_array().unwrap() {
                if visit(d.as_str().unwrap(), tasks, visiting, done) {
                    return true;
                }
            }
        }
        visiting.remove(id);
        done.insert(id);
        false
    }
    let (mut visiting, mut done) = (HashSet::new(), HashSet::new());
    if tasks
        .keys()
        .any(|id| visit(id, &tasks, &mut visiting, &mut done))
    {
        return Err("tasks: 任务依赖存在循环".into());
    }
    for (i, m) in w["milestones"].as_array().unwrap().iter().enumerate() {
        if let Some(d) = m.get("dueDate") {
            date(d, true)?;
        }
        if text(m, "state") == "completed"
            && (text(m, "evidence").trim().is_empty()
                || tasks
                    .values()
                    .any(|t| text(t, "milestoneId") == text(m, "id") && text(t, "state") != "done"))
        {
            return Err(format!(
                "milestones.{i}: 完成需要验收依据及全部关联任务完成"
            ));
        }
    }
    for (i, d) in w["decisions"].as_array().unwrap().iter().enumerate() {
        date(&d["date"], true)?;
        date(&d["followUpDate"], true)?;
        if text(d, "status") == "confirmed" && text(d, "conclusion").trim().is_empty() {
            return Err(format!("decisions.{i}.conclusion: 确认沟通前请记录结论"));
        }
    }
    Ok(())
}

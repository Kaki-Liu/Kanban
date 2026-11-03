//! Isolated JSON-lines harness for compatibility checks; never bundled for end users.
#[path = "../store.rs"] mod store;
#[path = "../exchange.rs"] mod exchange;
#[path = "../validation.rs"] mod validation;
use std::io::{self, BufRead};
use serde_json::{json, Value};
fn main() {
    let path = std::env::args().nth(1).expect("isolated database path required");
    let mut store = store::Store::new(path.into()).expect("open isolated database");
    for line in io::stdin().lock().lines() {
        let result = (|| -> Result<Value, String> {
            let request: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if let Some(now) = request["now"].as_str() { store.set_now(now)?; }
            store.dispatch(request["channel"].as_str().ok_or("missing channel")?, request["args"].as_array().cloned().unwrap_or_default())
        })();
        println!("{}", match result { Ok(value) => json!({"ok":true,"value":value}), Err(error) => json!({"ok":false,"error":error}) });
    }
}

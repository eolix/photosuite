//! Window › Actions, as engine commands (`actions.record` / `stop` / `play` / `list` / `get` /
//! `delete`).
//!
//! The list lives on [`Session`] so the panel, the CLI, the control channel and MCP share one
//! copy. Recording copies replayable journal entries (commands whose [`CommandSpec::journal`] is
//! set, except `actions.*`) into an action. Playback runs those steps with [`Session::execute`]
//! and stops at the first error, leaving one history step per step that ran.
//!
//! An untrusted session installs [`Session::authorize`]. `actions.play` calls it for every nested
//! step, because the outer `actions.play` id would otherwise hide a recorded `file.*` command from
//! the top-level check.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::{EngineError, Result, Session};

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

/// One recorded action. `steps` is the `[[id, params], …]` shape `file.automate.batch` and
/// droplets already accept.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Action {
    pub name: String,
    #[serde(default)]
    pub steps: Vec<(String, Value)>,
}

/// On-disk form of [`ActionState::list`] (`actions.json` in the preset store).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActionsFile {
    pub version: u32,
    pub actions: Vec<Action>,
}

/// Actions list and the recording / playback flags. Only `list` is persisted.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ActionState {
    pub list: Vec<Action>,
    /// Journal length when recording started, and the action index being recorded into.
    #[serde(skip)]
    pub recording: Option<(usize, usize)>,
    /// Nesting depth of `actions.play`. Greater than zero refuses another play.
    #[serde(skip)]
    pub playing: u8,
    /// Bumped whenever `list` changes, so the preset store can skip unchanged writes.
    #[serde(skip)]
    pub rev: u64,
}

impl ActionState {
    pub(crate) fn touch(&mut self) {
        self.rev = self.rev.saturating_add(1);
    }
}

/// A journal entry worth replaying: the command records itself, and it is not an `actions.*`
/// command (those would nest recording and playback).
pub fn replayable(id: &str) -> bool {
    !id.starts_with("actions.") && crate::commands::find(id).is_some_and(|c| c.journal)
}

fn always(_: &Session) -> std::result::Result<(), String> {
    Ok(())
}

fn num(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64))
}

fn resolve(list: &[Action], p: &Value, cmd: &str) -> Result<usize> {
    let Some(v) = p.get("action") else {
        return Err(bad(cmd, "needs \"action\" (a name or an index)"));
    };
    if let Some(i) = num(v) {
        if i < 0 {
            return Err(bad(cmd, "action index is negative"));
        }
        let Some(i) = usize::try_from(i).ok() else {
            return Err(bad(cmd, "action index is out of range"));
        };
        if i >= list.len() {
            return Err(bad(cmd, format!("no action at index {i}")));
        }
        return Ok(i);
    }
    match v.as_str() {
        Some(name) if !name.is_empty() => list.iter().position(|a| a.name == name).ok_or_else(|| bad(cmd, format!("no action named `{name}`"))),
        Some(_) => Err(bad(cmd, "action name is empty")),
        None => Err(bad(cmd, "\"action\" must be a name or an index")),
    }
}

fn from_step(p: &Value, len: usize) -> Result<usize> {
    let Some(v) = p.get("from") else { return Ok(0) };
    if v.is_null() {
        return Ok(0);
    }
    let Some(i) = num(v) else {
        return Err(bad("actions.play", "\"from\" must be a step index"));
    };
    if i < 0 {
        return Err(bad("actions.play", "\"from\" is negative"));
    }
    let Some(i) = usize::try_from(i).ok() else {
        return Err(bad("actions.play", "\"from\" is out of range"));
    };
    if i > len {
        return Err(bad("actions.play", format!("\"from\" {i} is past the last step ({len})")));
    }
    Ok(i)
}

fn list(s: &mut Session, _p: &Value) -> Result<Value> {
    let actions: Vec<Value> = s.actions.list.iter().map(|a| json!({"name": a.name, "steps": a.steps.len()})).collect();
    let recording = s.actions.recording.and_then(|(_, i)| s.actions.list.get(i).map(|a| a.name.clone()));
    Ok(json!({"actions": actions, "recording": recording}))
}

fn get(s: &mut Session, p: &Value) -> Result<Value> {
    let idx = resolve(&s.actions.list, p, "actions.get")?;
    let action = &s.actions.list[idx];
    let steps: Vec<Value> = action.steps.iter().map(|(id, params)| json!([id, params])).collect();
    Ok(json!({"name": action.name, "steps": steps}))
}

fn record(s: &mut Session, p: &Value) -> Result<Value> {
    if s.actions.recording.is_some() {
        return Err(bad("actions.record", "already recording; stop first"));
    }
    let idx = if p.get("action").is_some() {
        resolve(&s.actions.list, p, "actions.record")?
    } else {
        let name = match p.get("name") {
            None | Some(Value::Null) => format!("Action {}", s.actions.list.len() + 1),
            Some(Value::String(n)) if !n.is_empty() => n.clone(),
            Some(Value::String(_)) => return Err(bad("actions.record", "\"name\" is empty")),
            Some(_) => return Err(bad("actions.record", "\"name\" must be a string")),
        };
        s.actions.list.push(Action { name, steps: Vec::new() });
        s.actions.touch();
        s.actions.list.len() - 1
    };
    s.actions.recording = Some((s.journal.len(), idx));
    let name = s.actions.list.get(idx).map(|a| a.name.clone()).unwrap_or_default();
    Ok(json!({"action": name, "index": idx}))
}

fn stop(s: &mut Session, _p: &Value) -> Result<Value> {
    let Some((from, idx)) = s.actions.recording else {
        return Err(bad("actions.stop", "not recording"));
    };
    if idx >= s.actions.list.len() {
        return Err(bad("actions.stop", "the action being recorded no longer exists"));
    }
    let steps: Vec<(String, Value)> = s.journal.iter().skip(from).filter(|(id, _)| replayable(id)).cloned().collect();
    s.actions.recording = None;
    let action = &mut s.actions.list[idx];
    action.steps.extend(steps);
    let name = action.name.clone();
    let n = action.steps.len();
    s.actions.touch();
    Ok(json!({"action": name, "steps": n}))
}

fn run_recorded(s: &mut Session, steps: &[(String, Value)], from: usize) -> (u64, Option<Value>) {
    let mut ran = 0u64;
    let mut failed = None;
    for (i, (id, params)) in steps.iter().enumerate().skip(from) {
        if let Some(auth) = s.authorize
            && let Err(e) = auth(id, params)
        {
            failed = Some(json!({"step": i, "id": id, "error": e.to_string()}));
            break;
        }
        match s.execute(id, params.clone()) {
            Ok(_) => ran += 1,
            Err(e) => {
                failed = Some(json!({"step": i, "id": id, "error": e.to_string()}));
                break;
            }
        }
    }
    (ran, failed)
}

fn play(s: &mut Session, p: &Value) -> Result<Value> {
    if s.actions.playing > 0 {
        return Err(bad("actions.play", "an action is already playing"));
    }
    let idx = resolve(&s.actions.list, p, "actions.play")?;
    let action = s.actions.list[idx].clone();
    let from = from_step(p, action.steps.len())?;
    s.actions.playing = s.actions.playing.saturating_add(1);
    let (ran, failed) = run_recorded(s, &action.steps, from);
    s.actions.playing = s.actions.playing.saturating_sub(1);
    Ok(match failed {
        Some(f) => json!({"action": action.name, "ran": ran, "failed": f}),
        None => json!({"action": action.name, "ran": ran}),
    })
}

fn delete(s: &mut Session, p: &Value) -> Result<Value> {
    if s.actions.recording.is_some() {
        return Err(bad("actions.delete", "stop recording first"));
    }
    let idx = resolve(&s.actions.list, p, "actions.delete")?;
    let name = s.actions.list.remove(idx).name;
    s.actions.touch();
    Ok(json!({"deleted": name}))
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "actions.list",
            label: "List Actions",
            menu: &[],
            shortcut: None,
            params: "{} → {actions:[{name, steps:count}], recording:name|null}",
            enabled: always,
            run: list,
            journal: false,
        },
        CommandSpec {
            id: "actions.get",
            label: "Get Action",
            menu: &[],
            shortcut: None,
            params: r##"{"action":name|index} → {name, steps:[[id, params]…]} (the shape file.automate.batch and droplets take)"##,
            enabled: always,
            run: get,
            journal: false,
        },
        CommandSpec {
            id: "actions.record",
            label: "Record Action",
            menu: &[],
            shortcut: None,
            params: r##"{"name":str? (new action, default "Action N")} or {"action":name|index} (append) → {action, index}"##,
            enabled: always,
            run: record,
            journal: false,
        },
        CommandSpec {
            id: "actions.stop",
            label: "Stop Recording",
            menu: &[],
            shortcut: None,
            params: "{} → {action, steps:count} (steps recorded since actions.record, queries and actions.* omitted)",
            enabled: always,
            run: stop,
            journal: false,
        },
        CommandSpec {
            id: "actions.play",
            label: "Play Action",
            menu: &[],
            shortcut: None,
            params: r##"{"action":name|index, "from":step?} → {action, ran, failed?:{step, id, error}}. step and from are 0-based. Stops at the first error (the command still returns ok, with failed set) and leaves one history step per step that ran. Refuses to play while a play is already running. Each step is checked with Session::authorize when one is installed."##,
            enabled: always,
            run: play,
            journal: false,
        },
        CommandSpec {
            id: "actions.delete",
            label: "Delete Action",
            menu: &[],
            shortcut: None,
            params: r##"{"action":name|index} → {deleted:name}. Refused while recording."##,
            enabled: always,
            run: delete,
            journal: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pixel(s: &Session, layer: usize, x: i32, y: i32) -> Vec<f32> {
        s.active().unwrap().doc.layers[layer].surface().unwrap().pixel(x, y)
    }

    fn record_red(s: &mut Session, depth: u32) {
        s.execute("file.new", json!({"width": 40, "height": 40, "depth": depth})).unwrap();
        s.execute("actions.record", json!({"name": "Red"})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("select.rect", json!({"x": 0, "y": 0, "width": 10, "height": 10})).unwrap();
        s.execute("edit.fill", json!({"color": "#ff0000"})).unwrap();
        let _ = s.execute("document.pixel", json!({"x": 1, "y": 1}));
        let _ = s.execute("actions.list", json!({}));
        s.execute("actions.stop", json!({})).unwrap();
    }

    #[test]
    fn record_keeps_only_replayable_steps() {
        let mut s = Session::new();
        record_red(&mut s, 8);
        let got = s.execute("actions.get", json!({"action": "Red"})).unwrap();
        let ids: Vec<&str> = got["steps"].as_array().unwrap().iter().map(|st| st[0].as_str().unwrap()).collect();
        assert_eq!(ids, ["layer.new.layer", "select.rect", "edit.fill"]);
        assert!(s.journal.iter().all(|(id, _)| !id.starts_with("actions.")));
        let listed = s.execute("actions.list", json!({})).unwrap();
        assert_eq!(listed["actions"][0]["steps"], 3);
        assert!(listed["recording"].is_null());
    }

    #[test]
    fn play_on_another_document_matches_pixels_at_each_depth() {
        for depth in [8, 16, 32] {
            let mut s = Session::new();
            record_red(&mut s, depth);
            s.execute("file.new", json!({"width": 40, "height": 40, "depth": depth})).unwrap();
            let before = s.active().unwrap().history.past_len();
            let r = s.execute("actions.play", json!({"action": 0})).unwrap();
            assert!(r.get("failed").is_none(), "depth {depth}: {r}");
            assert_eq!(r["ran"], 3, "depth {depth}");
            assert_eq!(s.active().unwrap().doc.layers.len(), 2, "depth {depth}");
            assert_eq!(s.active().unwrap().history.past_len(), before + 3, "depth {depth}: one history step per played step");
            let px = pixel(&s, 1, 5, 5);
            assert!(px.iter().zip([1.0, 0.0, 0.0, 1.0]).all(|(a, b)| (a - b).abs() < 1.0e-5), "depth {depth}: {px:?}");
            assert_eq!(s.actions.playing, 0);
        }
    }

    #[test]
    fn play_stops_at_the_failing_step_and_reports_it() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
        s.execute("actions.record", json!({})).unwrap();
        s.execute("layer.new.layer", json!({"name": "One"})).unwrap();
        s.execute("actions.stop", json!({})).unwrap();
        s.actions.list[0].steps.push(("not.a.command".into(), json!({})));
        s.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
        let r = s.execute("actions.play", json!({"action": "Action 1"})).unwrap();
        assert_eq!(r["ran"], 1);
        assert_eq!(r["failed"]["step"], 1);
        assert_eq!(r["failed"]["id"], "not.a.command");
        assert!(r["failed"]["error"].as_str().unwrap().contains("unknown command"));
        assert_eq!(s.active().unwrap().doc.layers.len(), 2, "the step before the failure is kept");
        assert_eq!(s.actions.playing, 0);
        // A later play still runs.
        assert_eq!(s.execute("actions.play", json!({"action": 0, "from": 1})).unwrap()["ran"], 0);
    }

    #[test]
    fn play_refuses_recursion() {
        let mut s = Session::new();
        s.actions.list.push(Action { name: "Loop".into(), steps: vec![("actions.play".into(), json!({"action": "Loop"}))] });
        let r = s.execute("actions.play", json!({"action": "Loop"})).unwrap();
        assert_eq!(r["ran"], 0);
        assert_eq!(r["failed"]["id"], "actions.play");
        assert!(r["failed"]["error"].as_str().unwrap().contains("already playing"), "{r}");
        assert_eq!(s.actions.playing, 0);
    }

    #[test]
    fn play_checks_each_step_with_the_authorize_hook() {
        fn deny_file(id: &str, _: &Value) -> Result<()> {
            if id.starts_with("file.") { Err(EngineError::Other(format!("automation command `{id}` is disabled"))) } else { Ok(()) }
        }
        let mut s = Session::new();
        s.authorize = Some(deny_file);
        s.actions
            .list
            .push(Action { name: "Open".into(), steps: vec![("file.open".into(), json!({"path": "/etc/passwd"})), ("layer.new.layer".into(), json!({}))] });
        let r = s.execute("actions.play", json!({"action": "Open"})).unwrap();
        assert_eq!(r["ran"], 0);
        assert_eq!(r["failed"]["step"], 0);
        assert_eq!(r["failed"]["id"], "file.open");
        assert!(r["failed"]["error"].as_str().unwrap().contains("disabled"), "{r}");
        assert!(s.documents().is_empty(), "the refused step does not open a document");
    }

    #[test]
    fn append_delete_and_from_step() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 8, "height": 8, "background": "white"})).unwrap();
        let started = s.execute("actions.record", json!({"name": "Grow"})).unwrap();
        assert_eq!(started["index"], 0);
        s.execute("layer.new.layer", json!({"name": "One"})).unwrap();
        assert!(s.execute("actions.record", json!({})).is_err(), "already recording");
        assert!(s.execute("actions.delete", json!({"action": 0})).is_err(), "delete while recording");
        let stopped = s.execute("actions.stop", json!({})).unwrap();
        assert_eq!(stopped["steps"], 1);
        s.execute("actions.record", json!({"action": "Grow"})).unwrap();
        s.execute("layer.new.layer", json!({"name": "Two"})).unwrap();
        assert_eq!(s.execute("actions.stop", json!({})).unwrap()["steps"], 2);
        assert!(s.execute("actions.stop", json!({})).is_err(), "not recording");
        let before = s.active().unwrap().doc.layers.len();
        let r = s.execute("actions.play", json!({"action": "Grow", "from": 1})).unwrap();
        assert_eq!(r["ran"], 1);
        assert_eq!(s.active().unwrap().doc.layers.len(), before + 1);
        assert_eq!(s.execute("actions.delete", json!({"action": "Grow"})).unwrap()["deleted"], "Grow");
        assert!(s.actions.list.is_empty());
        assert!(s.execute("actions.get", json!({"action": "Grow"})).is_err());
    }

    #[test]
    fn bad_params_do_not_panic() {
        let mut s = Session::new();
        let junk = [
            Value::Null,
            json!([]),
            json!("x"),
            json!(1),
            json!({"action": true}),
            json!({"action": -1}),
            json!({"action": 99}),
            json!({"action": ""}),
            json!({"name": 1}),
            json!({"name": ""}),
            json!({"from": "start"}),
            json!({"from": -3}),
            json!({"action": "missing", "from": 4}),
        ];
        for id in ["actions.list", "actions.get", "actions.record", "actions.stop", "actions.play", "actions.delete"] {
            for p in &junk {
                let _ = s.execute(id, p.clone());
            }
        }
        assert_eq!(s.actions.playing, 0);
        assert!(crate::commands::command_specs().iter().any(|c| c.id == "actions.play" && !c.journal && c.menu.is_empty()));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn actions_persist_with_the_preset_store() {
        let dir = std::env::temp_dir().join(format!("pc-actions-{}-persist", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Session::new();
        let warnings = s.attach_preset_store(crate::preset_store::open_dir(&dir));
        assert!(warnings.iter().all(|w| !w.contains("actions")), "{warnings:?}");
        s.execute("file.new", json!({"width": 4, "height": 4})).unwrap();
        s.execute("actions.record", json!({"name": "Kept"})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("actions.stop", json!({})).unwrap();
        drop(s);

        let mut t = Session::new();
        t.attach_preset_store(crate::preset_store::open_dir(&dir));
        let listed = t.execute("actions.list", json!({})).unwrap();
        assert_eq!(listed["actions"][0]["name"], "Kept");
        assert_eq!(listed["actions"][0]["steps"], 1);
        assert_eq!(t.execute("actions.get", json!({"action": "Kept"})).unwrap()["steps"][0][0], "layer.new.layer");

        // An action created before the store finishes loading is kept, and a different one on
        // disk is merged in.
        let mut early = Session::new();
        early.execute("actions.record", json!({"name": "Early"})).unwrap();
        early.execute("actions.stop", json!({})).unwrap();
        early.attach_preset_store(crate::preset_store::open_dir(&dir));
        let names: Vec<String> = early.actions.list.iter().map(|a| a.name.clone()).collect();
        assert!(names.contains(&"Early".into()) && names.contains(&"Kept".into()), "{names:?}");

        std::fs::write(dir.join("actions.json"), b"{").unwrap();
        let mut bad = Session::new();
        let warnings = bad.attach_preset_store(crate::preset_store::open_dir(&dir));
        assert!(warnings.iter().any(|w| w.contains("actions")), "{warnings:?}");
        assert!(bad.actions.list.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

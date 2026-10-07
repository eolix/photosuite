use super::*;

fn session() -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 32, "height": 32})).unwrap();
    s
}

#[test]
fn defaults_match_photoshop() {
    let p = Preferences::default();
    assert_eq!(p.performance.history_states, 50);
    assert_eq!(p.guides_grid_and_slices.subdivisions, 4);
    assert_eq!(p.guides_grid_and_slices.guide_color, "#4affff");
    assert_eq!(p.transparency_and_gamut.colors(), [[255, 255, 255], [204, 204, 204]]);
    assert_eq!(p.transparency_and_gamut.square(), Some(8.0));
    assert_eq!(p.cursors.painting, PaintingCursor::NormalTip);
    // Every dialog section is a key of the JSON form.
    let v = p.to_json();
    for (id, _) in SECTIONS {
        assert!(v.get(id).is_some_and(Value::is_object), "{id}");
    }
}

#[test]
fn get_set_reset_by_path() {
    let mut s = session();
    assert_eq!(s.execute("prefs.get", json!({"path": "performance.historyStates"})).unwrap(), json!(50));
    s.execute("prefs.set", json!({"path": "performance.historyStates", "value": 3})).unwrap();
    assert_eq!(s.prefs().performance.history_states, 3);
    // Applied to open documents: only three undo steps remain.
    for i in 0..6 {
        s.execute("layer.new.layer", json!({"name": format!("L{i}")})).unwrap();
    }
    let mut n = 0;
    while s.undo() {
        n += 1;
    }
    assert_eq!(n, 3);
    // New documents too.
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    assert_eq!(s.active().unwrap().history.max_states, 3);
    s.execute("prefs.reset", json!({"path": "performance"})).unwrap();
    assert_eq!(s.prefs().performance.history_states, 50);
    assert_eq!(s.active().unwrap().history.max_states, 50);
}

#[test]
fn set_validates_and_is_all_or_nothing() {
    let mut s = session();
    for (path, value) in [
        ("cursors.painting", json!("huge")),
        ("performance.historyStates", json!(0)),
        ("performance.historyStates", json!("ten")),
        ("guidesGridAndSlices.guideColor", json!("cyan")),
        ("nope.nothing", json!(1)),
        ("general.notAField", json!(true)),
        ("shortcuts.edit.undo", json!("Cmd+Banana+Q")),
    ] {
        assert!(s.execute("prefs.set", json!({"path": path, "value": value})).is_err(), "{path}");
    }
    let r = s.execute("prefs.set", json!({"values": {"cursors.painting": "precise", "performance.historyStates": -4}}));
    assert!(r.is_err());
    assert_eq!(s.prefs().cursors.painting, PaintingCursor::NormalTip, "nothing applied");
    let r = s.execute("prefs.set", json!({"values": {"cursors.painting": "precise", "unitsAndRulers.rulers": "cm"}})).unwrap();
    assert_eq!(r["cursors.painting"], "precise");
    assert_eq!(s.prefs().units_and_rulers.rulers, Unit::Centimeters);
}

#[test]
fn whole_section_set_merges_keys() {
    let mut s = session();
    s.execute("prefs.set", json!({"path": "transparencyAndGamut", "value": {"gridSize": "large", "gridColors": "custom", "customDark": "#336699"}})).unwrap();
    let t = &s.prefs().transparency_and_gamut;
    assert_eq!(t.square(), Some(16.0));
    assert_eq!(t.colors()[1], [0x33, 0x66, 0x99]);
    assert_eq!(t.gamut_warning_color, "#808080", "untouched keys keep their values");
}

#[test]
fn json_round_trip_tolerates_unknown_and_missing_keys() {
    let mut s = session();
    s.execute("prefs.set", json!({"values": {"interface.theme": "pearl", "fileHandling.autosaveMinutes": 5, "shortcuts.edit.fill": "Cmd+Shift+F"}}))
        .unwrap();
    s.execute("edit.colorSettings", json!({"workingRgb": "display-p3", "policyRgb": "convert"})).unwrap();
    let text = s.prefs_to_json();
    let mut t = Session::new();
    t.load_prefs_json(&text).unwrap();
    assert_eq!(t.prefs(), s.prefs());
    assert_eq!(t.color.settings.working_rgb, "display-p3");
    assert_eq!(t.color.settings.policy_rgb, crate::color_cmds::Policy::Convert);
    // Older/newer files: unknown keys ignored, missing ones default.
    let mut u = Session::new();
    u.load_prefs_json(r#"{"general": {"beepWhenDone": true, "futureThing": 1}, "someNewSection": {}}"#).unwrap();
    assert!(u.prefs().general.beep_when_done);
    assert_eq!(u.prefs().performance.history_states, 50);
    assert!(u.load_prefs_json("not json").is_err());
}

#[test]
fn units_convert_both_ways() {
    for u in [Unit::Pixels, Unit::Inches, Unit::Centimeters, Unit::Millimeters, Unit::Points, Unit::Picas, Unit::Percent] {
        let v = u.from_px(450.0, 300.0, 900.0, 72.0);
        assert!((u.to_px(v, 300.0, 900.0, 72.0) - 450.0).abs() < 1e-9, "{u:?}");
    }
    assert_eq!(Unit::Inches.from_px(600.0, 300.0, 0.0, 72.0), 2.0);
    assert_eq!(Unit::Points.from_px(300.0, 300.0, 0.0, 72.0), 72.0);
    assert_eq!(Unit::Percent.from_px(450.0, 300.0, 900.0, 72.0), 50.0);
    let r = UnitsAndRulers { rulers: Unit::Centimeters, ..Default::default() };
    assert_eq!(r.format(300.0, 300.0, 0.0), "2.54");
}

#[test]
fn shortcuts_normalise_and_detect_conflicts() {
    assert_eq!(normalize_shortcut("shift+cmd+n").as_deref(), Some("Cmd+Shift+N"));
    assert_eq!(normalize_shortcut("Alt+Cmd+f7").as_deref(), Some("Cmd+Alt+F7"));
    assert_eq!(normalize_shortcut("Cmd++").as_deref(), Some("Cmd++"));
    assert_eq!(normalize_shortcut("Cmd+Shift"), None);
    assert_eq!(normalize_shortcut("Cmd+A+B"), None);
    let c = conflicts([("a", "Cmd+J"), ("b", "cmd+j"), ("c", "Cmd+K")]);
    assert_eq!(c, vec![("Cmd+J".to_string(), vec!["a".to_string(), "b".to_string()])]);
}

#[test]
fn keyboard_shortcuts_reassign_and_reset() {
    let mut s = session();
    let undo = crate::commands::find("edit.undo").unwrap().shortcut;
    assert_eq!(s.prefs().shortcut("edit.undo", undo), Some("Cmd+Z"));
    // Give ⌘Z to Fill: Undo loses it (Photoshop moves a shortcut rather than duplicating it).
    let r = s.execute("edit.keyboardShortcuts", json!({"set": {"edit.fill": "Cmd+Z"}})).unwrap();
    assert_eq!(s.prefs().shortcut("edit.fill", None), Some("Cmd+Z"));
    assert_eq!(s.prefs().shortcut("edit.undo", undo), None);
    assert!(r["conflicts"].as_array().unwrap().is_empty());
    // Keeping the duplicate reports a conflict.
    let r = s.execute("edit.keyboardShortcuts", json!({"set": {"edit.undo": "Cmd+Z"}, "removeConflicts": false})).unwrap();
    assert_eq!(r["conflicts"][0]["shortcut"], "Cmd+Z");
    assert!(s.execute("edit.keyboardShortcuts", json!({"set": {"no.such.command": "F9"}})).is_err());
    s.execute("edit.keyboardShortcuts", json!({"reset": true})).unwrap();
    assert!(s.prefs().shortcuts.is_empty());
    assert_eq!(s.prefs().shortcut("edit.undo", undo), Some("Cmd+Z"));
    // Listing with a filter.
    let r = s.execute("edit.keyboardShortcuts", json!({"filter": "gaussian"})).unwrap();
    assert!(r["commands"].as_array().unwrap().iter().any(|c| c["id"] == "filter.blur.gaussianBlur"));
}

/// #249: temporary tools (held keys) and the fill / colour keys are bindable like commands.
#[test]
fn temporary_tools_and_fill_keys_are_rebindable() {
    let mut s = session();
    let r = s.execute("edit.keyboardShortcuts", json!({"filter": "tools.temporary"})).unwrap();
    let ids: Vec<&str> = r["commands"].as_array().unwrap().iter().filter_map(|c| c["id"].as_str()).collect();
    assert!(ids.contains(&"tools.temporary.hand") && ids.contains(&"tools.temporary.zoomIn") && ids.contains(&"tools.temporary.zoomOut"), "{ids:?}");
    assert!(r["commands"].as_array().unwrap().iter().all(|c| c["hold"] == true));
    // Rebind the temporary zoom; an unknown id still fails.
    s.execute("edit.keyboardShortcuts", json!({"set": {"tools.temporary.zoomIn": "Ctrl+Space"}})).unwrap();
    assert_eq!(s.prefs().shortcut("tools.temporary.zoomIn", Some("Cmd+Space")), Some("Ctrl+Space"));
    assert!(s.execute("edit.keyboardShortcuts", json!({"set": {"tools.temporary.unknown": "Space"}})).is_err());
    // Taking a temporary tool's key for a command removes it from the temporary tool.
    s.execute("edit.keyboardShortcuts", json!({"set": {"edit.fillForeground": "Space"}})).unwrap();
    assert_eq!(s.prefs().shortcut("tools.temporary.hand", Some("Space")), None);
    assert_eq!(s.prefs().shortcut("edit.fillForeground", Some("Alt+Backspace")), Some("Space"));
    // D / X and the fill keys are listed with their Photoshop defaults.
    let r = s.execute("edit.keyboardShortcuts", json!({"list": true})).unwrap();
    let def = |id: &str| r["commands"].as_array().unwrap().iter().find(|c| c["id"] == id).map(|c| c["default"].clone());
    assert_eq!(def("tools.swapColors"), Some(json!("X")));
    assert_eq!(def("tools.defaultColors"), Some(json!("D")));
    assert_eq!(def("edit.fillBackground"), Some(json!("Cmd+Backspace")));
    // Bad values fail.
    assert!(s.execute("edit.keyboardShortcuts", json!({"set": {"tools.temporary.hand": 7}})).is_err());
}

#[test]
fn preferences_written_before_the_shipped_hidden_lists_take_them_on_load() {
    // The bug this guards: `#[serde(default)]` means a saved `"hidden": []` beats the Default
    // impl, so a file written by an earlier build showed every menu — and once the app had
    // saved prefs even once, later additions to prefs_hidden would never arrive.
    let mut s = session();
    s.load_prefs_json(r#"{"menus":{"hidden":[],"colors":{}},"toolbar":{"hidden":[],"order":[]}}"#).unwrap();
    let hidden = &s.prefs().menus.hidden;
    assert!(!hidden.is_empty(), "shipped defaults were not merged into an older file");
    for id in crate::prefs_hidden::HIDDEN_MENU_ITEMS {
        assert!(hidden.iter().any(|h| h == id), "{id} missing after merge");
    }
    assert_eq!(s.prefs().menus.defaults_version, crate::prefs_hidden::DEFAULTS_VERSION);
    for t in crate::prefs_hidden::HIDDEN_TOOLS {
        assert!(s.prefs().toolbar.hidden.iter().any(|h| h == t), "{t} missing after merge");
    }

    // A file already at the current version keeps the user's choices, including re-shown items.
    let kept = format!(
        r#"{{"menus":{{"hidden":["edit.fade"],"defaultsVersion":{v}}},"toolbar":{{"hidden":[],"defaultsVersion":{v}}}}}"#,
        v = crate::prefs_hidden::DEFAULTS_VERSION
    );
    s.load_prefs_json(&kept).unwrap();
    assert_eq!(s.prefs().menus.hidden, vec!["edit.fade".to_string()]);
    assert!(s.prefs().toolbar.hidden.is_empty());
}

#[test]
fn a_newer_defaults_version_adds_only_the_newly_hidden_items() {
    // Saved at version 1 with everything shown again: only what later versions hide arrives.
    let mut s = session();
    s.load_prefs_json(r#"{"menus":{"hidden":[],"defaultsVersion":1},"toolbar":{"hidden":[],"defaultsVersion":1}}"#).unwrap();
    let want: Vec<String> = crate::prefs_hidden::HIDDEN_MENU_ADDED.iter().filter(|(v, _)| *v > 1).map(|(_, id)| id.to_string()).collect();
    assert!(want.iter().any(|id| id == "file.saveACopy"));
    assert_eq!(s.prefs().menus.hidden, want);
    assert_eq!(s.prefs().menus.defaults_version, crate::prefs_hidden::DEFAULTS_VERSION);
    assert!(s.prefs().toolbar.hidden.is_empty(), "re-shown tools stay shown");
    for (_, id) in crate::prefs_hidden::HIDDEN_MENU_ADDED {
        assert!(crate::prefs_hidden::HIDDEN_MENU_ITEMS.contains(id), "{id} is in the additions but not the list");
    }
}

#[test]
fn menus_and_toolbar_customisation_persist() {
    let mut s = session();
    // `menus.hidden` starts at the shipped defaults (prefs_hidden::HIDDEN_MENU_ITEMS), so this
    // asserts the delta rather than the whole list.
    let baseline = s.prefs().menus.hidden.len();
    assert!(!s.prefs().menus.hidden.contains(&"edit.fade".to_string()));
    s.execute("edit.menus", json!({"hide": ["edit.fade"], "color": {"edit.fill": "red"}})).unwrap();
    assert!(s.prefs().menus.hidden.contains(&"edit.fade".to_string()));
    assert_eq!(s.prefs().menus.hidden.len(), baseline + 1);
    assert_eq!(s.prefs().menus.colors["edit.fill"], "red");
    assert!(s.execute("edit.menus", json!({"color": {"edit.fill": "plaid"}})).is_err());
    s.execute("edit.menus", json!({"show": ["edit.fade"], "color": {"edit.fill": "none"}})).unwrap();
    assert!(!s.prefs().menus.hidden.contains(&"edit.fade".to_string()));
    assert_eq!(s.prefs().menus.hidden.len(), baseline);
    assert!(s.prefs().menus.colors.is_empty());
    s.execute("edit.toolbar", json!({"hidden": ["Sponge"]})).unwrap();
    let back: Preferences = serde_json::from_str(&s.prefs_to_json()).unwrap();
    assert_eq!(back.toolbar.hidden, vec!["Sponge".to_string()]);
}

#[test]
fn preference_sections_are_commands() {
    let mut s = Session::new();
    for (id, title) in SECTIONS {
        let r = s.execute(&format!("edit.preferences.{id}"), json!({})).unwrap();
        assert_eq!(r["section"], id);
        assert_eq!(r["title"], title);
        assert!(r["values"].is_object(), "{id}");
    }
}

#[test]
fn choice_and_range_tables_cover_enum_fields() {
    let p = Preferences::default().to_json();
    for (id, _) in SECTIONS {
        for (k, v) in p[id].as_object().unwrap() {
            let path = format!("{id}.{k}");
            if let Some(c) = choices(&path) {
                assert!(c.contains(&v.as_str().unwrap()), "{path}");
            }
            if let Some((lo, hi)) = range(&path) {
                let x = v.as_f64().unwrap();
                assert!(x >= lo && x <= hi, "{path} default {x} outside {lo}..{hi}");
            }
            if is_color(&path) {
                assert!(parse_hex(v.as_str().unwrap()).is_some(), "{path}");
            }
        }
    }
}

#[test]
fn right_click_with_painting_tools_pref() {
    let mut s = session();
    assert_eq!(s.prefs().tools.right_click_with_painting_tools, RightClickPaint::BrushPicker, "Photoshop: the Brush Preset picker");
    assert_eq!(s.execute("prefs.get", json!({"path": "tools.rightClickWithPaintingTools"})).unwrap(), json!("brushPicker"));
    assert_eq!(choices("tools.rightClickWithPaintingTools"), Some(RightClickPaint::NAMES));
    s.execute("prefs.set", json!({"path": "tools.rightClickWithPaintingTools", "value": "erase"})).unwrap();
    assert_eq!(s.prefs().tools.right_click_with_painting_tools, RightClickPaint::Erase);
    for bad in [json!("smudge"), json!(1), json!(null), json!(["erase"])] {
        assert!(s.execute("prefs.set", json!({"path": "tools.rightClickWithPaintingTools", "value": bad})).is_err());
    }
    assert_eq!(s.prefs().tools.right_click_with_painting_tools, RightClickPaint::Erase, "rejected values change nothing");
    // Preferences saved before the option existed load with the default.
    let old: Tools = serde_json::from_value(json!({"showTooltips": false})).unwrap();
    assert_eq!(old.right_click_with_painting_tools, RightClickPaint::BrushPicker);
}

#[test]
fn gpu_backend_round_trips_and_validates() {
    let mut s = session();
    assert_eq!(s.prefs().performance.gpu_backend, GpuBackend::Auto);
    assert_eq!(s.execute("prefs.get", json!({"path": "performance.gpuBackend"})).unwrap(), json!("auto"));
    s.execute("prefs.set", json!({"path": "performance.gpuBackend", "value": "dx12"})).unwrap();
    assert_eq!(s.prefs().performance.gpu_backend, GpuBackend::Dx12);
    // Unknown names and wrong types are errors, and leave the value alone.
    assert!(s.execute("prefs.set", json!({"path": "performance.gpuBackend", "value": "directx"})).is_err());
    assert!(s.execute("prefs.set", json!({"path": "performance.gpuBackend", "value": 3})).is_err());
    assert_eq!(s.prefs().performance.gpu_backend, GpuBackend::Dx12);
    // Persisted and restored with the rest of the preferences.
    let text = s.prefs_to_json();
    let mut t = Session::new();
    t.load_prefs_json(&text).unwrap();
    assert_eq!(t.prefs().performance.gpu_backend, GpuBackend::Dx12);
    // Files from before the setting load as `auto`.
    let mut u = Session::new();
    u.load_prefs_json(r#"{"performance": {"useGpu": true}}"#).unwrap();
    assert_eq!(u.prefs().performance.gpu_backend, GpuBackend::Auto);
    assert_eq!(choices("performance.gpuBackend"), Some(GpuBackend::NAMES));
    for n in GpuBackend::NAMES {
        assert_eq!(GpuBackend::parse(n).map(GpuBackend::name), Some(*n));
    }
}

/// Preferences saved at version 3 (the six named Anti-Alias methods hidden, "None" not) take
/// "None" on load, so the Type menu goes away; anything the user re-showed stays shown.
#[test]
fn version_3_preferences_take_the_anti_alias_none_item() {
    let mut s = session();
    let json = r#"{"menus":{"defaultsVersion":3,"hidden":["type.antiAlias.sharp","type.antiAlias.crisp"],"colors":{}}}"#;
    s.load_prefs_json(json).unwrap();
    let hidden = &s.prefs().menus.hidden;
    assert!(hidden.iter().any(|h| h == "type.antiAlias.none"), "{hidden:?}");
    assert!(!hidden.iter().any(|h| h == "file.revert"), "items re-shown before stay shown: {hidden:?}");
    assert_eq!(s.prefs().menus.defaults_version, crate::prefs_hidden::DEFAULTS_VERSION);
}

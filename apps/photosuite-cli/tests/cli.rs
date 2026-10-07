//! Process-level tests of the `photosuite-cli` binary.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_photosuite-cli"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pc-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write_png(path: &Path, w: u32, h: u32, seed: u8) {
    let data: Vec<u8> = (0..w * h * 4).map(|i| (i as u8).wrapping_mul(seed).wrapping_add(seed)).collect();
    let img = photosuite_codecs::Image::from_u8(w, h, photosuite_codecs::ChannelLayout::Rgba, data).unwrap();
    std::fs::write(path, photosuite_codecs::encode(&img, photosuite_codecs::Format::Png, &Default::default()).unwrap()).unwrap();
}

fn ok(cmd: &mut Command) -> (String, String) {
    let o = cmd.output().unwrap();
    let (out, err) = (String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned());
    assert!(o.status.success(), "exit {:?}\nstdout: {out}\nstderr: {err}", o.status);
    (out, err)
}

#[test]
fn usage_and_unknown_command() {
    let o = bin().output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("USAGE"));
    let o = bin().arg("frobnicate").output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    let (out, _) = ok(bin().arg("--help"));
    assert!(out.contains("convert"));
    let (out, _) = ok(bin().arg("--version"));
    assert!(out.starts_with("photosuite-cli "));
}

/// #423: `<subcommand> --help` and `-h` print usage and return at once (no inputs read, no files
/// written, no server started), whatever else is on the line.
#[test]
fn every_subcommand_answers_help() {
    let d = tmp("help");
    for sub in ["convert", "info", "run", "batch", "droplet", "commands", "mcp", "serve"] {
        for help in ["--help", "-h"] {
            let o = bin().current_dir(&d).arg(sub).arg(help).arg("--out").arg("x.png").stdin(Stdio::null()).output().unwrap();
            let out = String::from_utf8_lossy(&o.stdout);
            assert_eq!(o.status.code(), Some(0), "{sub} {help}: {}", String::from_utf8_lossy(&o.stderr));
            assert!(out.contains("USAGE") && out.contains("photosuite-cli batch"), "{sub} {help}: {out}");
        }
    }
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0, "help wrote nothing");
}

/// #423: a flag the subcommand doesn't take is a usage error naming it, before any work.
#[test]
fn unknown_flags_are_usage_errors() {
    let d = tmp("flags");
    let input = d.join("in");
    std::fs::create_dir_all(&input).unwrap();
    write_png(&input.join("a.png"), 8, 4, 3);
    let actions = d.join("actions.json");
    std::fs::write(&actions, r#"[{"command":"image.adjustments.invert"}]"#).unwrap();
    let out_dir = d.join("out");
    let fails = |cmd: &mut Command, flag: &str| {
        let o = cmd.output().unwrap();
        let err = String::from_utf8_lossy(&o.stderr);
        assert_eq!(o.status.code(), Some(2), "{err}");
        assert!(err.contains(&format!("unknown flag {flag}")), "{err}");
    };
    for typo in [&["--fromat", "jpg"][..], &["--fromat=jpg"][..]] {
        fails(bin().args(["batch", "--actions"]).arg(&actions).arg("--in").arg(&input).arg("--out").arg(&out_dir).args(typo), "--fromat");
        assert!(!out_dir.exists(), "nothing written");
    }
    let x = d.join("x.png");
    fails(bin().arg("run").arg(input.join("a.png")).args(["--cmd", "image.adjustments.invert", "--param", "{}", "--out"]).arg(&x), "--param");
    assert!(!x.exists());
    // A flag one subcommand takes is still unknown to another; a bare flag takes no value.
    fails(bin().args(["info", "--json"]).arg(input.join("a.png")), "--json");
    let o = bin().args(["commands", "--json=yes"]).output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("--json takes no value"));
    // Every flag still works in both forms.
    let (out, _) = ok(bin().args(["commands", "--json", "--filter=gaussian"]));
    assert!(out.contains("filter.blur.gaussianBlur"), "{out}");
    ok(bin().args(["batch", "--actions"]).arg(&actions).arg(format!("--in={}", input.display())).arg("--out").arg(&out_dir).args([
        "--format=jpg",
        "--quality",
        "80",
    ]));
    assert!(out_dir.join("a.jpg").exists());
    let (out, _) = ok(bin().arg("info").arg(input.join("a.png")).arg("--compact"));
    assert!(!out.trim().contains('\n'), "compact JSON is one line");
}

#[test]
fn convert_png_pcraft_png_is_lossless() {
    let d = tmp("convert");
    let (a, b, c) = (d.join("a.png"), d.join("b.pcraft"), d.join("c.png"));
    write_png(&a, 37, 23, 7);
    ok(bin().args(["convert"]).arg(&a).arg(&b));
    assert!(photosuite_format::is_pcraft(&std::fs::read(&b).unwrap()));
    ok(bin().args(["convert"]).arg(&b).arg(&c));
    let x = photosuite_codecs::decode(&std::fs::read(&a).unwrap()).unwrap();
    let y = photosuite_codecs::decode(&std::fs::read(&c).unwrap()).unwrap();
    assert_eq!(x.to_rgba8(), y.to_rgba8());
    // Format override and lossy warning path.
    ok(bin().args(["convert"]).arg(&a).arg(d.join("out.bin")).args(["--format", "jpg", "--quality", "60"]));
    assert!(photosuite_codecs::detect(&std::fs::read(d.join("out.bin")).unwrap()) == Some(photosuite_codecs::Format::Jpeg));
    std::fs::remove_dir_all(d).unwrap();
}

#[test]
fn convert_errors() {
    let d = tmp("converr");
    let o = bin().args(["convert", "/missing/in.png"]).arg(d.join("x.png")).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    let o = bin().args(["convert", "only-one"]).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    std::fs::remove_dir_all(d).unwrap();
}

#[test]
fn info_prints_layer_tree_json() {
    let d = tmp("info");
    let a = d.join("a.png");
    write_png(&a, 10, 6, 3);
    let (out, _) = ok(bin().arg("info").arg(&a));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["width"], 10);
    assert_eq!(v["height"], 6);
    assert_eq!(v["layers"][0]["name"], "Background");
    assert!(v.get("history").is_none());
    let (out, _) = ok(bin().arg("info").arg(&a).arg("--compact"));
    assert_eq!(out.trim().lines().count(), 1);
    std::fs::remove_dir_all(d).unwrap();
}

#[test]
fn run_commands_and_save() {
    let d = tmp("run");
    let out_pc = d.join("r.pcraft");
    let (out, _) = ok(bin()
        .args(["run", "--new", r#"{"width":40,"height":30,"name":"Run"}"#])
        .args(["--cmd", "layer.new.layer", "--params", r#"{"name":"Ink"}"#])
        .args(["--cmd", "paint.stroke", "--params", r##"{"points":[[2,2,1],[30,20,1]],"size":5,"color":"#00ff00"}"##])
        .args(["--cmd", "document.inspect"])
        .arg("--out")
        .arg(&out_pc));
    let lines: Vec<Value> = out.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[2]["command"], "document.inspect");
    let (info, _) = ok(bin().arg("info").arg(&out_pc));
    let v: Value = serde_json::from_str(&info).unwrap();
    assert_eq!(v["name"], "Run");
    let names: Vec<&str> = v["layers"].as_array().unwrap().iter().filter_map(|l| l["name"].as_str()).collect();
    assert_eq!(names, ["Ink", "Background"]);
    // Continue from the saved file and export PNG.
    let png = d.join("r.png");
    ok(bin().arg("run").arg(&out_pc).args(["--cmd", "layer.new.layer"]).arg("--out").arg(&png));
    assert_eq!(photosuite_codecs::decode(&std::fs::read(&png).unwrap()).unwrap().dimensions(), (40, 30));
    std::fs::remove_dir_all(d).unwrap();
}

#[test]
fn run_errors() {
    let o = bin().args(["run", "--new", "{}", "--cmd", "no.such"]).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("unknown command"));
    let o = bin().args(["run", "--new", "{}", "--params", "{}"]).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    let o = bin().args(["run", "--new", "{", "--cmd", "x"]).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
}

#[test]
fn batch_applies_actions_to_directory() {
    let d = tmp("batch");
    let (inp, outp) = (d.join("in"), d.join("out"));
    std::fs::create_dir_all(&inp).unwrap();
    write_png(&inp.join("one.png"), 12, 8, 1);
    write_png(&inp.join("two.png"), 9, 9, 2);
    std::fs::write(inp.join("notes.txt"), "ignored").unwrap();
    let actions = d.join("actions.json");
    std::fs::write(&actions, json!([{"command": "layer.new.layer", "params": {"name": "Batch"}}]).to_string()).unwrap();
    let (out, _) = ok(bin().args(["batch", "--actions"]).arg(&actions).arg("--in").arg(&inp).arg("--out").arg(&outp).args(["--format", "pcraft"]));
    assert!(out.contains("2 succeeded, 0 failed"), "{out}");
    for n in ["one", "two"] {
        let (info, _) = ok(bin().arg("info").arg(outp.join(format!("{n}.pcraft"))));
        let v: Value = serde_json::from_str(&info).unwrap();
        assert_eq!(v["layers"][0]["name"], "Batch");
    }
    // A failing action reports and exits 1.
    std::fs::write(&actions, r#"{"actions":[{"id":"no.such.command"}]}"#).unwrap();
    let o = bin().args(["batch", "--actions"]).arg(&actions).arg("--in").arg(&inp).arg("--out").arg(&outp).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("FAIL"));
    std::fs::remove_dir_all(d).unwrap();
}

#[test]
fn parse_actions_formats() {
    let a = photosuite_cli::parse_actions(r#"[{"command":"a","params":{"x":1}},{"id":"b"}]"#).unwrap();
    assert_eq!(a, vec![("a".to_string(), json!({"x":1})), ("b".to_string(), json!({}))]);
    assert!(photosuite_cli::parse_actions(r#"{"actions":[{"command":"c"}]}"#).unwrap().len() == 1);
    assert!(photosuite_cli::parse_actions(r#"[{"params":{}}]"#).is_err());
    assert!(photosuite_cli::parse_actions("7").is_err());
    // #489: the step shapes a recorded action and a droplet store, bare or wrapped.
    let want = vec![("a".to_string(), json!({"x":1})), ("b".to_string(), json!({}))];
    for text in [
        r#"[["a",{"x":1}],["b"]]"#,
        r#"[["a",{"x":1}],"b"]"#,
        r#"{"steps":[["a",{"x":1}],["b",{}]]}"#,
        r#"{"photosuiteDroplet":1,"action":{"steps":[["a",{"x":1}],{"command":"b"}]}}"#,
        r#"{"actions":[["a",{"x":1}],["b",{}]]}"#,
    ] {
        assert_eq!(photosuite_cli::parse_actions(text).unwrap(), want, "{text}");
    }
    for text in ["[42]", "[[]]", "[[7,{}]]", r#"{"name":"x"}"#] {
        assert!(photosuite_cli::parse_actions(text).is_err(), "{text}");
    }
}

/// Runs `batch` on `input` with `actions` (saved as `<name>.json`), writing to the folder `<d>/<name>`.
fn batch_with(d: &Path, input: &Path, name: &str, actions: &str, extra: &[&str]) -> std::process::Output {
    let file = d.join(format!("{name}.json"));
    std::fs::write(&file, actions).unwrap();
    bin().args(["batch", "--actions"]).arg(&file).arg("--in").arg(input).arg("--out").arg(d.join(name)).args(extra).output().unwrap()
}

/// #489: `batch --actions` takes `[id, params]` steps and a droplet's steps, with the same results
/// as the object form; a malformed step fails before anything is written.
#[test]
fn batch_accepts_recorded_action_steps() {
    let d = tmp("batch-steps");
    let input = d.join("in");
    std::fs::create_dir_all(&input).unwrap();
    write_png(&input.join("a.png"), 8, 4, 3);
    write_png(&input.join("b.png"), 6, 5, 9);
    let shapes = [
        ("objects", r#"[{"command":"image.adjustments.invert"}]"#),
        ("pairs", r#"[["image.adjustments.invert",{}]]"#),
        ("ids", r#"["image.adjustments.invert"]"#),
        ("droplet", r#"{"photosuiteDroplet":1,"action":{"steps":[["image.adjustments.invert",{}]]}}"#),
    ];
    for (name, actions) in shapes {
        let o = batch_with(&d, &input, name, actions, &[]);
        assert!(o.status.success(), "{name}: {}", String::from_utf8_lossy(&o.stderr));
        assert!(String::from_utf8_lossy(&o.stdout).contains("2 succeeded, 0 failed"), "{name}");
        for f in ["a.png", "b.png"] {
            assert_eq!(std::fs::read(d.join(name).join(f)).unwrap(), std::fs::read(d.join("objects").join(f)).unwrap(), "{name}/{f}");
        }
    }
    let o = batch_with(&d, &input, "bad", "[42]", &[]);
    assert_eq!(o.status.code(), Some(1));
    assert!(!d.join("bad").exists(), "nothing written");
}

/// #490: a leading dot on `--format` doesn't double the dot in output names.
#[test]
fn batch_format_with_leading_dot() {
    let d = tmp("batch-dot");
    let input = d.join("in");
    std::fs::create_dir_all(&input).unwrap();
    write_png(&input.join("a.png"), 8, 4, 3);
    write_png(&input.join("b.png"), 6, 5, 9);
    let invert = r#"[{"command":"image.adjustments.invert"}]"#;
    for (name, format) in [("dot", ".jpg"), ("plain", "jpg")] {
        let o = batch_with(&d, &input, name, invert, &["--format", format]);
        assert!(o.status.success(), "{format}: {}", String::from_utf8_lossy(&o.stderr));
        let mut names: Vec<String> = std::fs::read_dir(d.join(name)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["a.jpg", "b.jpg"], "{format}");
        assert_eq!(photosuite_codecs::detect(&std::fs::read(d.join(name).join("a.jpg")).unwrap()), Some(photosuite_codecs::Format::Jpeg));
    }
}

/// #491: `--quality` outside 1-100 is an error for every subcommand, whatever the number's size,
/// and nothing is written.
#[test]
fn quality_outside_1_to_100_is_refused() {
    let d = tmp("quality");
    let input = d.join("in");
    std::fs::create_dir_all(&input).unwrap();
    let a = input.join("a.png");
    write_png(&a, 8, 4, 3);
    let invert = r#"[{"command":"image.adjustments.invert"}]"#;
    for q in ["0", "101", "255", "256", "1000", "-1", "abc", "50.5", ""] {
        let out = d.join("q.jpg");
        let (mut convert, mut run) = (bin(), bin());
        convert.arg("convert").arg(&a).arg(&out).args(["--quality", q]);
        run.arg("run").arg(&a).args(["--cmd", "image.adjustments.invert", "--out"]).arg(&out).args(["--quality", q]);
        for cmd in [&mut convert, &mut run] {
            let o = cmd.output().unwrap();
            assert_eq!(o.status.code(), Some(1), "--quality {q}");
            assert!(String::from_utf8_lossy(&o.stderr).contains(&format!("bad --quality `{q}`: expected a whole number from 1 to 100")), "--quality {q}");
            assert!(!out.exists(), "--quality {q} wrote a file");
        }
        let o = batch_with(&d, &input, "qb", invert, &["--format", "jpg", "--quality", q]);
        assert_eq!(o.status.code(), Some(1), "batch --quality {q}");
        assert!(!d.join("qb").exists(), "batch --quality {q} wrote a folder");
    }
    // The documented range still encodes, lower quality making a smaller file.
    let sizes: Vec<usize> = ["1", "50", "100"]
        .iter()
        .map(|q| {
            let out = d.join(format!("q{q}.jpg"));
            ok(bin().arg("convert").arg(&a).arg(&out).args(["--quality", q]));
            std::fs::read(out).unwrap().len()
        })
        .collect();
    assert!(sizes[0] <= sizes[1] && sizes[1] <= sizes[2], "{sizes:?}");
}

/// #492: an `--out` folder that is the `--in` folder, however it is spelt, is refused before
/// anything is written, unless `--in-place` asks for it.
#[test]
fn batch_refuses_to_write_over_its_inputs() {
    let d = tmp("batch-in-place");
    let input = d.join("in");
    std::fs::create_dir_all(&input).unwrap();
    write_png(&input.join("a.png"), 8, 4, 3);
    let img = photosuite_codecs::Image::from_u8(8, 4, photosuite_codecs::ChannelLayout::Rgb, vec![90; 96]).unwrap();
    std::fs::write(input.join("a.tif"), photosuite_codecs::encode(&img, photosuite_codecs::Format::Tiff, &Default::default()).unwrap()).unwrap();
    let actions = d.join("actions.json");
    std::fs::write(&actions, r#"[{"command":"image.adjustments.invert"}]"#).unwrap();
    let snapshot = || {
        let mut files: Vec<(PathBuf, Vec<u8>)> =
            std::fs::read_dir(&input).unwrap().map(|e| e.unwrap().path()).map(|p| (p.clone(), std::fs::read(p).unwrap())).collect();
        files.sort();
        files
    };
    let before = snapshot();
    let batch = |out: &Path, extra: &[&str]| {
        bin().current_dir(&d).args(["batch", "--actions"]).arg(&actions).args(["--in", "in", "--out"]).arg(out).args(extra).output().unwrap()
    };
    #[cfg(unix)]
    std::os::unix::fs::symlink(&input, d.join("link")).unwrap();
    let link = cfg!(unix).then(|| PathBuf::from("link"));
    for out in [PathBuf::from("in"), PathBuf::from("./in/"), input.clone(), input.join(".")].iter().chain(&link) {
        for extra in [&[][..], &["--format", "tif"][..]] {
            let o = batch(out, extra);
            let err = String::from_utf8_lossy(&o.stderr);
            assert_eq!(o.status.code(), Some(1), "--out {} {extra:?}: {err}", out.display());
            assert!(err.contains("is the --in folder") && err.contains("--in-place"), "{err}");
            assert_eq!(snapshot(), before, "--out {} {extra:?} changed the originals", out.display());
        }
    }
    // A separate folder runs as before, leaving the originals alone.
    let (out, _) = ok(bin().current_dir(&d).args(["batch", "--actions"]).arg(&actions).args(["--in", "in", "--out", "out"]));
    assert!(out.contains("2 succeeded, 0 failed"), "{out}");
    assert_eq!(snapshot(), before);
    // `--in-place` opts in: each result replaces its original.
    let o = batch(Path::new("in"), &["--in-place"]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let after = snapshot();
    assert_eq!(after.len(), 2);
    assert!(after.iter().zip(&before).all(|(a, b)| a.0 == b.0 && a.1 != b.1), "both inputs replaced");
}

#[test]
fn commands_listing() {
    let (out, _) = ok(bin().arg("commands"));
    assert!(out.contains("file.new"));
    let (out, _) = ok(bin().args(["commands", "--json", "--filter", "layer.new"]));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(
        v.as_array()
            .unwrap()
            .iter()
            .all(|c| { c["id"].as_str().unwrap().contains("layer.new") || c["label"].as_str().unwrap().to_lowercase().contains("layer.new") })
    );
}

#[test]
fn in_process_run_matches_binary() {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = photosuite_cli::run(&["commands".into(), "--filter".into(), "file.new".into()], &mut out, &mut err);
    assert_eq!(code, 0);
    assert!(String::from_utf8(out).unwrap().contains("file.new"));
}

#[test]
fn mcp_stdio_handshake_and_tool_call() {
    let mut child = bin().arg("mcp").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |v: Value| {
        writeln!(stdin, "{v}").unwrap();
        stdin.flush().unwrap();
    };
    let mut recv = |id: u64| -> Value {
        loop {
            let mut line = String::new();
            assert!(stdout.read_line(&mut line).unwrap() > 0, "server closed");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == id {
                return v;
            }
        }
    };
    send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}));
    let init = recv(1);
    assert_eq!(init["result"]["serverInfo"]["name"], "photosuite", "{init}");
    send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}));
    let tools = recv(2);
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"command_run") && names.contains(&"doc_render_preview"), "{names:?}");
    send(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"doc_new","arguments":{"width":8,"height":8}}}));
    let r = recv(3);
    assert_ne!(r["result"]["isError"], true, "{r}");
    send(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"doc_render_preview","arguments":{}}}));
    let r = recv(4);
    assert_eq!(r["result"]["content"][0]["type"], "image", "{r}");
    let _ = child.kill();
    let _ = child.wait();
}

/// `--format` mapping two inputs to one name fails the second instead of overwriting the first (#420).
#[test]
fn batch_fails_inputs_that_share_an_output_name() {
    let d = tmp("batch-collide");
    let input = d.join("in");
    std::fs::create_dir_all(&input).unwrap();
    write_png(&input.join("a.png"), 8, 4, 3);
    // Same stem in other formats; `A.tif` differs only in case.
    let img = photosuite_codecs::Image::from_u8(8, 4, photosuite_codecs::ChannelLayout::Rgb, vec![90; 96]).unwrap();
    for (name, format) in [("a.bmp", photosuite_codecs::Format::Bmp), ("A.tif", photosuite_codecs::Format::Tiff)] {
        std::fs::write(input.join(name), photosuite_codecs::encode(&img, format, &Default::default()).unwrap()).unwrap();
    }
    let actions = d.join("actions.json");
    std::fs::write(&actions, r#"[{"command":"image.adjustments.invert"}]"#).unwrap();
    let out_dir = d.join("out");
    let o = bin().args(["batch", "--actions"]).arg(&actions).arg("--in").arg(&input).arg("--out").arg(&out_dir).args(["--format", "png"]).output().unwrap();
    let (out, err) = (String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    assert!(
        !o.status.success(),
        "a lost result must fail the run
{out}
{err}"
    );
    assert!(out.contains("1 succeeded, 2 failed"), "{out}");
    assert_eq!(err.matches("not written").count(), 2, "{err}");
    assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 1);
    // Keeping each file's format, every input gets its own output.
    let out_dir = d.join("same");
    let (out, _) = ok(bin().args(["batch", "--actions"]).arg(&actions).arg("--in").arg(&input).arg("--out").arg(&out_dir));
    assert!(out.contains("3 succeeded, 0 failed"), "{out}");
}

#[test]
fn droplet_runs_an_action_on_files() {
    let d = tmp("droplet");
    write_png(&d.join("a.png"), 8, 4, 3);
    write_png(&d.join("b.png"), 6, 2, 5);
    let droplet = d.join("rot.pcdroplet");
    std::fs::write(
        &droplet,
        json!({"photosuiteDroplet": 1, "name": "rot", "action": {"steps": [["image.imageRotation.90cw", {}]]}, "options": {"format": "png"}}).to_string(),
    )
    .unwrap();
    let out_dir = d.join("out");
    let (out, _) = ok(bin().arg("droplet").arg(&droplet).arg(d.join("a.png")).arg(d.join("b.png")).arg("--out").arg(&out_dir));
    assert_eq!(out.lines().filter(|l| l.starts_with("ok")).count(), 2, "{out}");
    let img = photosuite_codecs::decode(&std::fs::read(out_dir.join("a.png")).unwrap()).unwrap();
    assert_eq!(img.dimensions(), (4, 8));
    let o = bin().arg("droplet").arg(d.join("a.png")).arg(d.join("b.png")).output().unwrap();
    assert!(!o.status.success(), "not a droplet");
}

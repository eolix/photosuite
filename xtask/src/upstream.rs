//! `cargo xtask upstream`: port fixes from upstream PhotoCraft (storytold/photocraft), keeping
//! each one's author, date and message. The runbook and the ledger are `docs/upstream-sync.md`.
//!
//! PhotoSuite began as a file copy of PhotoCraft, so the two share no git history. To port an
//! upstream commit, this builds two commits in our repository: the commit's parent and the
//! commit itself, each holding only the files the commit touches, renamed the way PhotoSuite
//! names things ([`map_text`]). Cherry-picking the second onto our tree is then a real three-way
//! merge, file by file, with the upstream parent as the base. Nothing upstream is pushed: the
//! two commits sit under the local `refs/upstream/` namespace.
//!
//! A commit counts as ported when our history has a `Ported-from: storytold/photocraft@<sha>`
//! trailer for it, and as decided when it is ported or listed in the ledger (skip, superseded).

use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const LEDGER: &str = "docs/upstream-sync.md";
const PIN_PREFIX: &str = "Synced through: `";
const TRAILER: &str = "Ported-from: storytold/photocraft@";
const UPSTREAM_BRANCH: &str = "origin/main";

const USAGE: &str = "\
usage: cargo xtask upstream <command>

  status [--fetch] [--all]   upstream commits after the pin that are not decided yet (--all:
                             every commit after the pin), with a guess at their kind and how many
                             of their files PhotoSuite has changed since (\"diverged\")
  port <sha>                 apply one upstream commit to the working tree (renamed, three-way),
                             without committing; prints the files held back and the commit command
  skip <sha> <reason>…       record a decision not to port it in the ledger
  pin                        move the ledger's \"Synced through\" to the last commit before the
                             first undecided one

The upstream checkout is ../photocraft, or $PHOTOSUITE_UPSTREAM_DIR.";

pub fn run(root: &Path, args: &[&str]) -> Result<(), String> {
    let up = upstream_dir(root);
    match args {
        ["status", rest @ ..] => status(root, &up, rest.contains(&"--fetch"), rest.contains(&"--all")),
        ["port", sha] => port(root, &up, sha),
        ["skip", sha, reason @ ..] if !reason.is_empty() => skip(root, &up, sha, &reason.join(" ")),
        ["pin"] => pin(root, &up),
        _ => Err(USAGE.to_string()),
    }
}

fn upstream_dir(root: &Path) -> PathBuf {
    std::env::var_os("PHOTOSUITE_UPSTREAM_DIR").map(PathBuf::from).unwrap_or_else(|| root.join("../photocraft"))
}

// ---------------------------------------------------------------------------------------------
// Renaming

/// Text that names PhotoCraft on purpose (attribution, upstream links, the corpus repository) and
/// must survive [`map_text`] unchanged.
const KEEP: &[&str] = &["storytold/photocraft", "photocraft-corpus", "PhotoCraft contributors", "PhotoCraft (https://", "PhotoCraft](https://"];

/// PhotoCraft's names → PhotoSuite's: the app id (the macOS bundle uses `app.photosuite`), then
/// every casing of the name.
fn map_text(text: &str, path: &str) -> String {
    let mut s = text.to_string();
    let mut guards = Vec::new();
    for (i, k) in KEEP.iter().enumerate() {
        let g = format!("\u{1}KEEP{i}\u{1}");
        if s.contains(k) {
            s = s.replace(k, &g);
            guards.push((g, *k));
        }
    }
    let app_id = if path.starts_with("packaging/macos/") { "app.photosuite" } else { "io.github.eolix.PhotoSuite" };
    s = s.replace("ai.storyteller.photocraft", app_id);
    for (from, to) in [("PHOTOCRAFT", "PHOTOSUITE"), ("PhotoCraft", "PhotoSuite"), ("Photocraft", "Photosuite"), ("photocraft", "photosuite")] {
        s = s.replace(from, to);
    }
    for (g, k) in guards {
        s = s.replace(&g, k);
    }
    s
}

/// Upstream paths never applied automatically: everything under `docs/` (PhotoSuite writes its
/// own; upstream's also carries brand material under trademark terms), the app icon, licence and
/// attribution files, all of the translation machinery (PhotoSuite's own), and CI (a different setup). They are
/// listed after a port for a person to look at.
fn held_back(path: &str) -> bool {
    const PREFIXES: &[&str] = &["docs/", "assets/app-icon/", "book/", ".github/", "crates/ui-egui/src/i18n/"];
    const FILES: &[&str] = &["NOTICE", "ATTRIBUTION.md", "LICENSE-MIT", "LICENSE-APACHE", "README.md", "AGENTS.md", "THIRD-PARTY-NOTICES.md", "THIRD-PARTY-CRATES.md", "SECURITY.md"];
    PREFIXES.iter().any(|p| path.starts_with(p)) || FILES.contains(&path)
}

/// Upstream issue references (`#784`) point at PhotoCraft's tracker, not ours.
fn qualify_issue_refs(msg: &str) -> String {
    let b = msg.as_bytes();
    let mut out = String::with_capacity(msg.len() + 32);
    let mut i = 0;
    while i < b.len() {
        let prev_ok = i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'/' || b[i - 1] == b'&');
        if b[i] == b'#' && prev_ok && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
            out.push_str("storytold/photocraft");
        }
        let ch = msg[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8().max(1);
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Git helpers

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").current_dir(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {} failed in {}:\n{}", args.join(" "), dir.display(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git").current_dir(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {} failed:\n{}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

/// Runs git with `input` on stdin and extra environment variables.
fn git_in(dir: &Path, args: &[&str], env: &[(&str, &str)], input: &[u8]) -> Result<String, String> {
    let mut c = Command::new("git");
    c.current_dir(dir).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().map_err(|e| format!("git: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input).map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {} failed:\n{}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn full_sha(up: &Path, sha: &str) -> Result<String, String> {
    Ok(git(up, &["rev-parse", "--verify", &format!("{sha}^{{commit}}")])?.trim().to_string())
}

// ---------------------------------------------------------------------------------------------
// The ledger

struct Ledger {
    pin: String,
    decided: BTreeMap<String, String>,
}

fn read_ledger(root: &Path) -> Result<Ledger, String> {
    let text = std::fs::read_to_string(root.join(LEDGER)).map_err(|e| format!("{LEDGER}: {e}"))?;
    let pin = text
        .lines()
        .find_map(|l| l.strip_prefix(PIN_PREFIX).and_then(|r| r.split('`').next()))
        .ok_or_else(|| format!("{LEDGER}: no \"{PIN_PREFIX}…`\" line"))?
        .to_string();
    let mut decided = BTreeMap::new();
    for l in text.lines() {
        let cells: Vec<&str> = l.split('|').map(str::trim).collect();
        if let [_, sha, decision, ..] = cells.as_slice()
            && let Some(sha) = sha.strip_prefix('`').and_then(|s| s.strip_suffix('`'))
            && sha.len() >= 7
            && sha.bytes().all(|b| b.is_ascii_hexdigit())
        {
            decided.insert(sha.to_string(), decision.to_string());
        }
    }
    Ok(Ledger { pin, decided })
}

/// Upstream shas our history says were ported (the `Ported-from` trailers).
fn ported(root: &Path) -> Result<HashSet<String>, String> {
    let log = git(root, &["log", "--format=%B", "HEAD"])?;
    Ok(log.lines().filter_map(|l| l.trim().strip_prefix(TRAILER)).map(|s| s.trim().to_string()).collect())
}

fn is_decided(sha: &str, ported: &HashSet<String>, ledger: &Ledger) -> Option<String> {
    if ported.contains(sha) {
        return Some("ported".into());
    }
    ledger.decided.iter().find(|(k, _)| sha.starts_with(k.as_str())).map(|(_, v)| v.clone())
}

// ---------------------------------------------------------------------------------------------
// status / skip / pin

struct UpCommit {
    sha: String,
    subject: String,
}

fn commits_after_pin(up: &Path, pin: &str) -> Result<Vec<UpCommit>, String> {
    let range = format!("{pin}..{UPSTREAM_BRANCH}");
    let out = git(up, &["log", "--reverse", "--first-parent", "--format=%H%x09%s", &range])?;
    Ok(out.lines().filter_map(|l| l.split_once('\t')).map(|(h, s)| UpCommit { sha: h.to_string(), subject: s.to_string() }).collect())
}

/// A guess from the subject; the session doing the sync decides.
fn kind(subject: &str) -> &'static str {
    let s = subject.to_lowercase();
    let chore = ["rustfmt", "i18n", "ci:", "ci ", "docs", "chore", "readme", "bump ", "release "];
    let fix = ["fix", "crash", "panic", "overflow", "reject", "guard", "bound", "no longer", "repair", "handle ", "stale", "regression", "wrong"];
    if chore.iter().any(|w| s.starts_with(w)) {
        "chore"
    } else if fix.iter().any(|w| s.contains(w)) {
        "fix"
    } else {
        "feature"
    }
}

/// PhotoSuite's commit subjects start with one of these types, and nothing else.
const TYPES: &[&str] = &["feat", "fix", "chore", "docs", "nit"];

/// The message with its subject as `<type>: <description>`. The description is upstream's subject
/// without its own `word:` / `word(scope):` prefix; the type is that prefix when it is one of
/// [`TYPES`], and otherwise the one [`kind`] guesses (`feature` → `feat`). The body is kept.
fn standard_subject(message: &str) -> String {
    let (subject, rest) = message.split_once('\n').unwrap_or((message, ""));
    let subject = subject.trim();
    let guessed = match kind(subject) {
        "feature" => "feat",
        k => k,
    };
    let (ty, description) = match subject.split_once(':') {
        Some((head, tail)) if !head.is_empty() && head.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "()-_/".contains(c)) => {
            let word = head.split('(').next().unwrap_or(head);
            (TYPES.iter().find(|t| **t == word).copied().unwrap_or(guessed), tail.trim())
        }
        _ => (guessed, subject),
    };
    if rest.is_empty() { format!("{ty}: {description}") } else { format!("{ty}: {description}\n{rest}") }
}

/// How many of the commit's files PhotoSuite no longer has as upstream had them before it
/// (changed here, or gone), out of the files it touches that existed.
fn divergence(root: &Path, up: &Path, sha: &str) -> Result<(usize, usize), String> {
    let mut diverged = 0;
    let mut existing = 0;
    for (status, path) in changed_files(up, sha)? {
        if status == 'A' || held_back(&path) {
            continue;
        }
        existing += 1;
        let before = git_bytes(up, &["show", &format!("{sha}^:{path}")])?;
        let mapped = map_path(&path);
        let ours = std::fs::read(root.join(&mapped)).ok();
        let expected = match String::from_utf8(before) {
            Ok(t) => map_text(&t, &path).into_bytes(),
            Err(e) => e.into_bytes(),
        };
        if ours.as_deref() != Some(expected.as_slice()) {
            diverged += 1;
        }
    }
    Ok((diverged, existing))
}

fn map_path(path: &str) -> String {
    map_text(path, path)
}

/// (status letter, path) for each file the commit changes against its first parent.
fn changed_files(up: &Path, sha: &str) -> Result<Vec<(char, String)>, String> {
    let out = git(up, &["diff-tree", "-r", "--no-renames", "--no-commit-id", "--name-status", &format!("{sha}^"), sha])?;
    Ok(out.lines().filter_map(|l| l.split_once('\t')).map(|(s, p)| (s.chars().next().unwrap_or('M'), p.to_string())).collect())
}

fn status(root: &Path, up: &Path, fetch: bool, all: bool) -> Result<(), String> {
    if fetch {
        git(up, &["fetch", "--quiet", "origin"])?;
    }
    let ledger = read_ledger(root)?;
    let ported = ported(root)?;
    let commits = commits_after_pin(up, &ledger.pin)?;
    println!("pin {}  ({} upstream commits after it on {UPSTREAM_BRANCH})", &ledger.pin[..ledger.pin.len().min(12)], commits.len());
    let mut open = 0;
    for c in &commits {
        let decided = is_decided(&c.sha, &ported, &ledger);
        if decided.is_some() && !all {
            continue;
        }
        open += usize::from(decided.is_none());
        let (div, n) = divergence(root, up, &c.sha).unwrap_or((0, 0));
        let state = decided.unwrap_or_else(|| kind(&c.subject).to_string());
        println!("{}  {state:<10} diverged {div:>2}/{n:<3} {}", &c.sha[..10], c.subject);
    }
    println!("{open} undecided");
    Ok(())
}

fn skip(root: &Path, up: &Path, sha: &str, reason: &str) -> Result<(), String> {
    let full = full_sha(up, sha)?;
    let path = root.join(LEDGER);
    let mut text = std::fs::read_to_string(&path).map_err(|e| format!("{LEDGER}: {e}"))?;
    if read_ledger(root)?.decided.keys().any(|k| full.starts_with(k.as_str())) {
        return Err(format!("{} is already in the ledger", &full[..10]));
    }
    let subject = git(up, &["log", "-1", "--format=%s", &full])?.trim().replace('|', "/");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("| `{}` | skip | {} — {} |\n", &full[..10], reason.replace('|', "/"), subject));
    std::fs::write(&path, text).map_err(|e| format!("{LEDGER}: {e}"))?;
    println!("recorded: skip {} ({reason})", &full[..10]);
    Ok(())
}

fn pin(root: &Path, up: &Path) -> Result<(), String> {
    let ledger = read_ledger(root)?;
    let ported = ported(root)?;
    let commits = commits_after_pin(up, &ledger.pin)?;
    let mut new_pin = ledger.pin.clone();
    for c in &commits {
        if is_decided(&c.sha, &ported, &ledger).is_none() {
            break;
        }
        new_pin = c.sha.clone();
    }
    if new_pin == ledger.pin {
        println!("pin stays at {}", &ledger.pin[..10]);
        return Ok(());
    }
    let path = root.join(LEDGER);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{LEDGER}: {e}"))?;
    let text = text.replace(&format!("{PIN_PREFIX}{}`", ledger.pin), &format!("{PIN_PREFIX}{new_pin}`"));
    std::fs::write(&path, text).map_err(|e| format!("{LEDGER}: {e}"))?;
    println!("pin {} → {}", &ledger.pin[..10], &new_pin[..10]);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// port

/// One side (before / after) of the commit's files, renamed, as a tree in our repository.
fn side_tree(root: &Path, up: &Path, rev: &str, paths: &[String]) -> Result<String, String> {
    let idx = root.join("target/upstream-port.index");
    if let Some(d) = idx.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(&idx);
    let idx_s = idx.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", idx_s.as_str())];
    let mut info = String::new();
    for p in paths {
        let ls = git(up, &["ls-tree", rev, "--", p])?;
        let Some((meta, _)) = ls.trim().split_once('\t') else { continue };
        let mode = meta.split_whitespace().next().unwrap_or("100644");
        let bytes = git_bytes(up, &["show", &format!("{rev}:{p}")])?;
        let bytes = match String::from_utf8(bytes) {
            Ok(t) => map_text(&t, p).into_bytes(),
            Err(e) => e.into_bytes(),
        };
        let blob = git_in(root, &["hash-object", "-w", "--stdin"], &[], &bytes)?;
        info.push_str(&format!("{mode} {}\t{}\n", blob.trim(), map_path(p)));
    }
    git_in(root, &["update-index", "--add", "--index-info"], &env, info.as_bytes())?;
    let tree = git_in(root, &["write-tree"], &env, b"")?;
    let _ = std::fs::remove_file(&idx);
    Ok(tree.trim().to_string())
}

fn port(root: &Path, up: &Path, sha: &str) -> Result<(), String> {
    let full = full_sha(up, sha)?;
    let short = &full[..10];
    if !git(root, &["status", "--porcelain", "--untracked-files=no"])?.trim().is_empty() {
        return Err("the working tree has changes: commit or stash them first, so the port is its own change".into());
    }
    if ported(root)?.contains(&full) {
        return Err(format!("{short} is already ported (a Ported-from trailer names it)"));
    }
    let files = changed_files(up, &full)?;
    let (held, apply): (Vec<_>, Vec<_>) = files.into_iter().partition(|(_, p)| held_back(p));
    let paths: Vec<String> = apply.iter().map(|(_, p)| p.clone()).collect();
    if paths.is_empty() {
        println!("{short} only touches held-back files:");
        for (s, p) in &held {
            println!("  {s} {p}");
        }
        return Ok(());
    }
    // Author, date and message as upstream wrote them; issue numbers point at upstream.
    let meta = git(up, &["log", "-1", "--format=%an%x00%ae%x00%aD%x00%B", &full])?;
    let mut parts = meta.splitn(4, '\0');
    let (name, email, date, body) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let message = format!("{}\n\n{TRAILER}{full}\n", standard_subject(&qualify_issue_refs(body.trim_end())));
    let env = [("GIT_AUTHOR_NAME", name), ("GIT_AUTHOR_EMAIL", email), ("GIT_AUTHOR_DATE", date)];
    let base_tree = side_tree(root, up, &format!("{full}^"), &paths)?;
    let new_tree = side_tree(root, up, &full, &paths)?;
    let base = git_in(root, &["commit-tree", &base_tree, "-m", &format!("upstream base of storytold/photocraft@{full}")], &env, b"")?;
    let base = base.trim();
    let commit = git_in(root, &["commit-tree", &new_tree, "-p", base, "-F", "-"], &env, message.as_bytes())?;
    let commit = commit.trim().to_string();
    git(root, &["update-ref", &format!("refs/upstream/ported/{short}"), &commit])?;
    let pick = Command::new("git").current_dir(root).args(["cherry-pick", "--no-commit", &commit]).output().map_err(|e| format!("git: {e}"))?;
    println!("{short} {}", body.lines().next().unwrap_or(""));
    println!("  by {name} <{email}>, {date}");
    if pick.status.success() {
        println!("  applied cleanly to the working tree ({} files)", paths.len());
    } else {
        println!("  applied with conflicts — resolve them (git status), or `git cherry-pick --abort` to drop the port:");
        print!("{}", String::from_utf8_lossy(&pick.stdout));
        print!("{}", String::from_utf8_lossy(&pick.stderr));
    }
    if !held.is_empty() {
        println!("  held back (look at them by hand: git -C {} show {short} -- <path>):", up.display());
        for (s, p) in &held {
            println!("    {s} {p}");
        }
    }
    println!("  then build and test, and commit it as upstream wrote it (author, date, message + trailer):");
    println!("    git commit -C {commit}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_mapped_and_attribution_is_kept() {
        let src = "use photocraft_doc::Layer; PhotocraftApp; PHOTOCRAFT_CONFIG_DIR; photocraft-cli\n\
                   See https://github.com/storytold/photocraft/issues/1 and storytold/photocraft-corpus.\n\
                   © ArtCraft Team and the PhotoCraft contributors. Built on PhotoCraft (https://github.com/storytold/photocraft).\n\
                   The PhotoCraft window. ai.storyteller.photocraft.desktop";
        let out = map_text(src, "crates/x.rs");
        assert!(out.contains("use photosuite_doc::Layer; PhotosuiteApp; PHOTOSUITE_CONFIG_DIR; photosuite-cli"));
        assert!(out.contains("https://github.com/storytold/photocraft/issues/1 and storytold/photocraft-corpus."));
        assert!(out.contains("the PhotoCraft contributors. Built on PhotoCraft (https://github.com/storytold/photocraft)."));
        assert!(out.contains("The PhotoSuite window. io.github.eolix.PhotoSuite.desktop"));
        assert_eq!(map_text("<string>ai.storyteller.photocraft</string>", "packaging/macos/Info.plist.in"), "<string>app.photosuite</string>");
        assert_eq!(map_path("apps/photocraft-cli/src/lib.rs"), "apps/photosuite-cli/src/lib.rs");
    }

    #[test]
    fn brand_licences_translations_and_ci_are_held_back() {
        for p in ["docs/brand/artcraft-logo.svg", "docs/architecture.md", "docs/roadmap.md", "docs/scorecard.md", "assets/app-icon/hicolor/16x16/apps/x.png", "NOTICE", "README.md", ".github/workflows/ci.yml", "crates/ui-egui/src/i18n/ja.tsv"] {
            assert!(held_back(p), "{p}");
        }
        assert!(held_back("crates/ui-egui/src/i18n/mod.rs") && held_back("ATTRIBUTION.md"));
        for p in ["crates/engine/src/lib.rs", "crates/io/README.md"] {
            assert!(!held_back(p), "{p}");
        }
    }

    #[test]
    fn subjects_take_photosuite_types() {
        for (from, to) in [
            ("fix(automation): downscale bridge screenshots (#753)", "fix: downscale bridge screenshots (#753)"),
            ("feat(ui): add bounded Liquify redo history (#435)", "feat: add bounded Liquify redo history (#435)"),
            ("docs: add star history chart to README (#469)", "docs: add star history chart to README (#469)"),
            ("i18n: add Czech (cs) UI translation (#328)", "chore: add Czech (cs) UI translation (#328)"),
            ("algo: fix flaky cancel/progress test (#609)", "fix: fix flaky cancel/progress test (#609)"),
            ("rustfmt crates/ui-egui/src/canvas.rs (#819)", "chore: rustfmt crates/ui-egui/src/canvas.rs (#819)"),
            ("Marquee: stop the selection at the canvas edge (#263)", "feat: Marquee: stop the selection at the canvas edge (#263)"),
            ("Fix vector pixel bounds overflow (#747)", "fix: Fix vector pixel bounds overflow (#747)"),
        ] {
            assert_eq!(standard_subject(from), to);
        }
        assert_eq!(standard_subject("fix(x): a\n\nbody\nmore"), "fix: a\n\nbody\nmore");
    }

    #[test]
    fn issue_numbers_point_at_upstream() {
        assert_eq!(
            qualify_issue_refs("Fix it (#709) (#805)\n\nSee storytold/photocraft#3, a#1, x/#2, &#39;"),
            "Fix it (storytold/photocraft#709) (storytold/photocraft#805)\n\nSee storytold/photocraft#3, a#1, x/#2, &#39;"
        );
        assert_eq!(qualify_issue_refs("#12 first"), "storytold/photocraft#12 first");
        assert_eq!(qualify_issue_refs("é #1"), "é storytold/photocraft#1");
    }

    #[test]
    fn kinds_are_guessed_from_the_subject() {
        assert_eq!(kind("fix(geom): Rect::width no longer overflows"), "fix");
        assert_eq!(kind("Bound layer-group nesting at import"), "fix");
        assert_eq!(kind("rustfmt crates/x.rs"), "chore");
        assert_eq!(kind("Add the Content-Aware Move tool"), "feature");
    }
}

# Contributing to PhotoSuite

Thanks for your interest in contributing to PhotoSuite!

Before making changes, please read the [README](README.md) and check the relevant documentation in [`docs/`](docs/).

## Getting Started

### Prerequisites

PhotoSuite uses JavaScript, Rust, and Tauri. Make sure you have:

* Node.js and npm
* Rust and Cargo
* Git
* Tauri's platform-specific prerequisites

Check your installation with:

```bash
node --version
npm --version
rustc --version
cargo --version
```

### Clone and Install

PhotoSuite uses Git submodules:

```bash
git clone --recursive https://github.com/eolix/photosuite.git
cd photosuite
npm install
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

Start the application with:

```bash
npm run dev
```

## Project Structure

The main areas of the repository are:

```text
src/          Main application source
src-tauri/    Rust/Tauri native layer
tests/        JavaScript tests
docs/         Project documentation
scripts/      Development and maintenance scripts
examples/     Examples and plugins
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the complete architecture documentation.

### Architecture

PhotoSuite follows a layered architecture:

```text
app → ui → features → document → engine → core
```

New code should respect these dependency boundaries.

Avoid:

* Import cycles
* Barrel files inside `src/`
* Global application registries used to bypass the architecture
* Unnecessary global state

Run `npm run verify` to check architectural constraints.

## Coding Guidelines

* Follow the style of the surrounding code.
* Keep changes focused and avoid unrelated refactoring.
* Reuse existing project patterns where possible.
* Avoid unnecessary dependencies.
* Keep application code separate from vendored third-party code.
* Run `npm run lint` for JavaScript changes.

For third-party code under `src/vendor/`, see [`src/vendor/README.md`](src/vendor/README.md) before making changes.

## Testing & Verification

PhotoSuite uses Node's built-in test runner.

Run the test suite:

```bash
npm test
```

Run a specific test:

```bash
node --test tests/core/math/point.test.js
```

Tests generally mirror the source tree:

```text
src/path/to/module.js
tests/path/to/module.test.js
```

Tests should focus on observable behavior rather than implementation details.

Before opening a PR, run the checks relevant to your changes:

```bash
npm test
npm run lint
npm run verify
```

For Rust/Tauri changes, also run:

```bash
cargo test
```

See [`tests/README.md`](tests/README.md) for more testing guidance.

## Making Changes

Create a focused branch for your work:

```bash
git checkout -b <type>/<short-description>
```

Keep pull requests focused on one problem or improvement.

When changing behavior:

* Add or update tests where appropriate.
* Update relevant documentation.
* Review your changes with `git diff`.
* Remove debugging code and unrelated changes.

## Pull Requests

Before opening a PR:

* Run the relevant tests and checks.
* Review the complete diff.
* Make sure no unrelated files are included.
* Update documentation when necessary.

A PR description should explain:

* **What** changed
* **Why** it changed
* **How** it was tested
* Related issue(s), if applicable

For UI changes, include screenshots or recordings when useful.

## What Contributions Are Welcome

Contributions are welcome in areas such as:

* Bug fixes
* Tests and regression tests
* Documentation
* UI/UX improvements
* Performance improvements
* Image editing functionality
* File-format support
* Plugins
* Development and build tooling

For larger changes, consider discussing the approach in an issue before starting significant implementation work.

## Reporting Issues

Before opening an issue, check whether it has already been reported.

For bug reports, include:

* Steps to reproduce
* Expected and actual behavior
* Relevant logs or errors
* Operating system and PhotoSuite version/commit
* Screenshots or sample files when useful

For feature requests, describe the problem, proposed solution, and expected behavior.

## License

Contributions to PhotoSuite are licensed under the project's license. See [`LICENSE`](LICENSE) for details.

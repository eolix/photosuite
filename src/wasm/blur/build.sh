#!/bin/sh
# Rebuild blur.wasm from blur.rs. Requires: rustup target add wasm32-unknown-unknown
set -e
rustc --target wasm32-unknown-unknown \
  -C opt-level=3 -C lto=fat -C panic=abort -C strip=symbols \
  --crate-type cdylib -o ../blur.wasm blur.rs
echo "built ../blur.wasm ($(wc -c < ../blur.wasm) bytes)"

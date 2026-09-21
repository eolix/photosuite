#!/bin/sh
# Rebuild median.wasm from median.rs. Requires: rustup target add wasm32-unknown-unknown
set -e
rustc --target wasm32-unknown-unknown \
  -C opt-level=3 -C lto=fat -C panic=abort -C strip=symbols \
  --crate-type cdylib -o ../median.wasm median.rs
echo "built ../median.wasm ($(wc -c < ../median.wasm) bytes)"

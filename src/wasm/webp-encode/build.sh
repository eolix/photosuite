#!/bin/sh
# Rebuild webp-encode.wasm from webp_encode.rs. Requires:
#   rustup target add wasm32-unknown-unknown
set -e
cd "$(dirname "$0")"
RUSTFLAGS="-C link-arg=-zstack-size=33554432" \
  cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/webp_encode_wasm.wasm ../webp-encode.wasm
echo "built ../webp-encode.wasm ($(wc -c < ../webp-encode.wasm) bytes)"

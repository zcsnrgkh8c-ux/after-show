#!/bin/sh
set -eu

rm -rf out
mkdir -p out
cp -R payload/server out/server
cp -R payload/shared out/shared
cp -R payload/fixtures out/fixtures
cp -R payload/web out/web
cp gateway.cjs out/gateway.cjs
cp run.sh out/run.sh
chmod 755 out/run.sh

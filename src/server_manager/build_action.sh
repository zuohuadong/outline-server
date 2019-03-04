#!/bin/bash -eu
#
# Copyright 2018 The Outline Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Generate do_install_script.ts.
readonly TMPGZ=$(mktemp)
tar --create --gzip -f $TMPGZ src/server_manager/install_scripts/*.sh
mkdir -p src/server_manager/install_scripts
node src/server_manager/install_scripts/build_install_script_ts.node.js $TMPGZ > src/server_manager/install_scripts/do_install_script.ts

# Compile.
yarn tsc -p src/server_manager
rsync -ac --exclude '*.ts' src/server_manager/ build/server_manager/

# Browserify a subset of node_modules/ and the app.
mkdir -p build/server_manager/browserified
browserify --require bytes --require clipboard-polyfill -o build/server_manager/browserified/node_modules.js
browserify build/server_manager/web_app/main.js -s main -o build/server_manager/browserified/main.js

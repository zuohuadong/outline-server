// Copyright 2020 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const path = require('path');
const webpack = require('webpack');

const config = {
  mode: 'development',  // TODO(alalama): production
  entry: path.resolve(__dirname, './server/main.ts'),
  target: 'node',
  output: {
    filename: 'main.js',
    path: path.resolve(__dirname, '../../build/shadowbox/app'),
    // publicPath: '/root/app/',
  },
  module: {rules: [{test: /\.ts(x)?$/, use: 'ts-loader'}]},
  plugins: [
    // require does not work without this
    new webpack.DefinePlugin({'global.GENTLY': false})
  ],
  // node: {
  // global: true,
  // __filename: true,
  // __dirname: true,
  // },
  resolve: {extensions: ['.tsx', '.ts', '.js']},
  // stats: 'verbose',
};

module.exports = config;
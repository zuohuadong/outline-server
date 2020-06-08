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

export interface AccessServiceConfig {
  certificateFilename: string;
  certificateSha256Fingerprint: string;
  privateKeyFilename: string;
  port: number;
  // TODO(alalama): s/prefix/path
  prefix: string;
}

// {
//   // Frequency on which the service destroys and (re)creates access keys.
//   accessKeyRotationIntervalHours: number
//   // Data transfer limit for all access keys managed by the service.
//   dataLimit: number
//   // Threshold for the number of access keys that the service can create.
//   maxNumAccessKeys: number
// }

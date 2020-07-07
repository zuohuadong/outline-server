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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import fetch, {RequestInit, Response} from 'node-fetch';
import * as restify from 'restify';
import * as restifyErrors from 'restify-errors';
import * as uuidv4 from 'uuid/v4';

import {PortProvider} from '../infrastructure/get_port';
import * as logging from '../infrastructure/logging';
import {AccessServiceConfig} from '../model/access_service';

// TODO(alalama): interfaces! tests!
// TODO(alalama): rename file to shadowbox_access_service.ts?

export class ShadowboxAccessService {
  private server: restify.Server|undefined;

  // TODO(alalama): `persistentStateDir` is currently unused, will be needed to persist certs
  constructor(
      private accessService: ShadowboxAccessServiceApi, private portProvider: PortProvider,
      private persistentStateDir, private config?: AccessServiceConfig) {}

  async start(): Promise<AccessServiceConfig> {
    if (this.server) {
      throw new Error('access server already started');
    }

    if (!this.config) {
      this.config = await this.generateConfig();
    }

    this.server = restify.createServer({
      certificate: fs.readFileSync(this.config.certificateFilename),
      key: fs.readFileSync(this.config.privateKeyFilename)
    });
    const prefix = `/${this.config.prefix}`;
    this.bindService(this.server, prefix, this.accessService);
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, () => {
        resolve(this.config);
      });
    });
  }

  async stop() {
    if (!this.server) {
      throw new Error('access server not started');
    }
    this.server.close();
    this.server = undefined;
    this.config = undefined;
  }

  private async generateConfig(): Promise<AccessServiceConfig> {
    // TODO(alalama): generate and persist certificates
    const certificateFilename = process.env.SB_CERTIFICATE_FILE;
    const privateKeyFilename = process.env.SB_PRIVATE_KEY_FILE;
    const port = await this.portProvider.reserveNewPort();
    const prefix = Buffer.from(uuidv4()).toString('base64').replace(/=/g, '').slice(0, 16);

    // Compute the certificate SHA256 fingerprint. Equivalent to:
    // openssl x509 -in $CERT -noout -sha256 -fingerprint
    const certificate = fs.readFileSync(certificateFilename);
    const certBase64 = certificate.toString()
                           .split('\n')
                           .filter(l => !l.includes('-----'))
                           .map(l => l.trim())
                           .join('');
    const certificateSha256Fingerprint = crypto.createHash('sha256')
                                             .update(Buffer.from(certBase64, 'base64'))
                                             // TODO(alalama): hex output?
                                             .digest('base64');

    return {certificateFilename, privateKeyFilename, port, prefix, certificateSha256Fingerprint};
  }

  // TODO(alalama): only pass prefix
  private bindService(server: restify.Server, prefix: string, service: ShadowboxAccessServiceApi) {
    server.get(`${prefix}/access-keys`, service.listAccessKeys.bind(service));
  }
}

export class ShadowboxAccessServiceApi {
  constructor(private managementApiUrl: string) {}

  // TODO(alalama): implement access policy; keep track of access keys created
  async listAccessKeys(req: restify.Request, res: restify.Response, next: restify.Next) {
    logging.debug('listAccessKeys request');
    const accessKeys = await this.apiRequest<{}>('access-keys', {method: 'GET'});
    const accessKeysResponse = accessKeys['accessKeys'].map((key) => {
      return {host: key.host, port: key.port, password: key.password, cipher: key.method};
    });
    res.send(200, accessKeysResponse);
    next();
  }

  private async apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.managementApiUrl}/${path}`;
    const agent = new https.Agent({
      // This is safe because the management API URL is on localhost.
      // Our threat model doesn't include localhost port interception.
      // TODO(alalama): pin management API certificate via `checkServerIdentity` function.
      rejectUnauthorized: false
    });
    if (!options) {
      options = {};
    }
    options.agent = agent;

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`API request to ${path} failed with status ${response.status}`);
    }
    return response.json();
  }
}

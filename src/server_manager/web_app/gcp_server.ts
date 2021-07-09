// Copyright 2021 The Outline Authors
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

import * as gcp_api from '../cloud/gcp_api';
import * as errors from '../infrastructure/errors';
import {sleep} from '../infrastructure/sleep';
import {Zone} from '../model/gcp';
import * as server from '../model/server';
import {DataAmount, ManagedServerHost, MonetaryCost} from '../model/server';

import {ShadowboxServer} from './shadowbox_server';

enum InstallState {
  // Unknown state - server request may still be pending.
  UNKNOWN = 0,
  // All required resources (VMs, IPs, Firewall rules) have been created
  CREATED,
  // The system has booted (detected by the creation of guest tags)
  BOOTED,
  // Server is running and has the API URL and certificate fingerprint set.
  SUCCESS,
  // Server is in an error state.
  ERROR,
  // Server has been deleted.
  DELETED
}

export class GcpServer extends ShadowboxServer implements server.ManagedServer {
  private static readonly GUEST_ATTRIBUTES_POLLING_INTERVAL_MS = 5 * 1000;

  private readonly gcpHost: GcpHost;
  private installState: InstallState = InstallState.UNKNOWN;
  private listener: (progress: number) => void = null;

  constructor(
      id: string,
      private locator: gcp_api.InstanceLocator,
      instanceName: string,
      private completion: Promise<void>,
      private apiClient: gcp_api.RestApiClient) {
    super(id);
    this.gcpHost = new GcpHost(locator, instanceName, completion, apiClient, this.onDelete.bind(this));
  }

  getHost(): ManagedServerHost {
    return this.gcpHost;
  }

  isInstallCompleted(): boolean {
    return this.installState >= InstallState.SUCCESS;
  }

  async waitOnInstall(): Promise<void> {
    await this.completion;
    this.setInstallState(InstallState.CREATED);
    while (this.installState < InstallState.SUCCESS) {
      const outlineGuestAttributes = await this.getOutlineGuestAttributes();
      if (outlineGuestAttributes.size > 0 && this.installState < InstallState.BOOTED) {
        this.setInstallState(InstallState.BOOTED);
      }
      if (outlineGuestAttributes.has('apiUrl') && outlineGuestAttributes.has('certSha256')) {
        const certSha256 = outlineGuestAttributes.get('certSha256');
        const apiUrl = outlineGuestAttributes.get('apiUrl');
        trustCertificate(certSha256);
        this.setManagementApiUrl(apiUrl);
        this.setInstallState(InstallState.SUCCESS);
      } else if (outlineGuestAttributes.has('install-error')) {
        this.setInstallState(InstallState.ERROR);
        throw new errors.ServerInstallFailedError();
      }

      await sleep(GcpServer.GUEST_ATTRIBUTES_POLLING_INTERVAL_MS);
    }
  }

  setProgressListener(listener: (progress: number) => void): void {
    this.listener = listener;
    listener(this.installProgress());
  }

  private setInstallState(newState: InstallState): void {
    this.installState = newState;
    if (this.listener) {
      this.listener(this.installProgress());
    }
  }

  private installProgress(): number {
    // Installation typically takes 5 minutes in total.
    switch (this.installState) {
      case InstallState.UNKNOWN: return 0.1;
      case InstallState.CREATED: return 0.2;
      case InstallState.BOOTED: return 0.8;
      case InstallState.SUCCESS: return 1.0;
      default: return 0;
    }
  }

  private async getOutlineGuestAttributes(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const guestAttributes =
        await this.apiClient.getGuestAttributes(this.locator, 'outline/');
    const attributes = guestAttributes?.queryValue?.items ?? [];
    attributes.forEach((entry) => {
      result.set(entry.key, entry.value);
    });
    return result;
  }

  private onDelete() {
    // TODO: Consider setInstallState.
    this.installState = InstallState.DELETED;
  }
}

class GcpHost implements server.ManagedServerHost {
  constructor(
      private locator: gcp_api.InstanceLocator,
      private addressName: string,
      private completion: Promise<void>,
      private apiClient: gcp_api.RestApiClient,
      private deleteCallback: Function) {}

  // TODO: Throw error and show message on failure
  async delete(): Promise<void> {
    // TODO: Support deletion of servers that failed to complete setup, or
    // never got a static IP.
    await this.completion;
    const regionId = this.getCloudLocation().regionId;
    await this.apiClient.deleteStaticIp({regionId, ...this.locator}, this.addressName);
    this.apiClient.deleteInstance(this.locator);
    this.deleteCallback();
  }

  getHostId(): string {
    return this.locator.instanceId;
  }

  getMonthlyCost(): MonetaryCost {
    return undefined;
  }

  getMonthlyOutboundTransferLimit(): DataAmount {
    return undefined;
  }

  getCloudLocation(): Zone {
    return new Zone(this.locator.zoneId);
  }
}

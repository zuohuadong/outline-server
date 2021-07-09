// Copyright 2018 The Outline Authors
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

import {EventEmitter} from 'eventemitter3';

import {DigitalOceanSession, DropletInfo} from '../cloud/digitalocean_api';
import * as errors from '../infrastructure/errors';
import {asciiToHex, hexToString} from '../infrastructure/hex_encoding';
import { Region } from '../model/digitalocean';
import * as server from '../model/server';

import {ShadowboxServer} from './shadowbox_server';

// Prefix used in key-value tags.
const KEY_VALUE_TAG = 'kv';
// The tag key for the manager API certificate fingerprint.
const CERTIFICATE_FINGERPRINT_TAG = 'certsha256';
// The tag key for the manager API URL.
const API_URL_TAG = 'apiurl';
// The tag which appears if there is an error during installation.
const INSTALL_ERROR_TAG = 'install-error';

// These are superseded by the API_URL_TAG
// The tag key for the manager API port.
const DEPRECATED_API_PORT_TAG = 'apiport';
// The tag key for the manager API url prefix.
const DEPRECATED_API_PREFIX_TAG = 'apiprefix';

// Possible install states for DigitaloceanServer.
enum InstallState {
  // Unknown state - server may still be installing.
  UNKNOWN = 0,
  // Server status is "active"
  CREATED,
  // Userspace is running (detected by the presence of tags)
  BOOTED,
  // Server is running and has the API URL and certificate fingerprint set.
  SUCCESS,
  // Server is in an error state.
  ERROR,
  // Server has been deleted.
  DELETED
}

export class DigitalOceanServer extends ShadowboxServer implements server.ManagedServer {
  private eventQueue = new EventEmitter();
  private installState: InstallState = InstallState.UNKNOWN;
  private listener: (progress: number) => void = null;

  constructor(
      id: string, private digitalOcean: DigitalOceanSession, private dropletInfo: DropletInfo) {
    // Consider passing a RestEndpoint object to the parent constructor,
    // to better encapsulate the management api address logic.
    super(id);
    console.info('DigitalOceanServer created');
    this.eventQueue.once('server-active', () => console.timeEnd('activeServer'));
    this.pollInstallState();
  }

  waitOnInstall(): Promise<void> {
    return new Promise((fulfill, reject) => {
      // Poll this.installState for changes.  This can poll quickly as it
      // will not make any network requests.
      const intervalId = setInterval(() => {
        if (this.installState < InstallState.SUCCESS) {
          // Final installState not known, wait until next retry.
          return;
        }
        // Final state is now known, so we can stop checking.
        clearInterval(intervalId);
        if (this.installState === InstallState.SUCCESS) {
          fulfill();
        } else if (this.installState === InstallState.ERROR) {
          reject(new errors.ServerInstallFailedError());
        } else if (this.installState === InstallState.DELETED) {
          reject(new errors.DeletedServerError());
        }
      }, 100);
    });
  }

  // Sets this.installState, will keep polling until this.installState can
  // be set to something other than UNKNOWN.
  private pollInstallState(): void {
    const TIMEOUT_MS = 5 * 60 * 1000;
    const startTimestamp = Date.now();

    // Synchronous function for updating the installState, which doesn't
    // refresh droplet info.
    const updateInstallState = (): void => {
      if (this.installState >= InstallState.SUCCESS) {
        // Final state is already known, so it cannot be changed.
        return;
      }
      const tagMap = this.getTagMap();
      if (tagMap[INSTALL_ERROR_TAG]) {
        console.error(`error tag: ${tagMap[INSTALL_ERROR_TAG]}`);
        this.setInstallState(InstallState.ERROR);
      } else if (Date.now() - startTimestamp >= TIMEOUT_MS) {
        console.error('hit timeout while waiting for installation');
        this.setInstallState(InstallState.ERROR);
      } else if (this.setApiUrlAndCertificate()) {
        // API Url and Certificate have been set, so we have successfully
        // installed the server and can now make API calls.
        console.info('digitalocean_server: Successfully found API and cert tags');
        this.setInstallState(InstallState.SUCCESS);
      } else if (Object.keys(tagMap).length > 0) {
        this.setInstallState(InstallState.BOOTED);
      } else if (this.dropletInfo?.status === 'active') {
        this.setInstallState(InstallState.CREATED);
      }
    };

    // Attempt to set the install state immediately, based on the initial
    // droplet info, to possibly save on a refresh API call.
    updateInstallState();
    if (this.installState >= InstallState.SUCCESS) {
      return;
    }

    // Periodically refresh the droplet info then try to update the install
    // state again.
    const intervalId = setInterval(async () => {
      // Check if the final install state has been reached, so we don't make an
      // unnecessary request to fetch droplet info.
      if (this.installState >= InstallState.SUCCESS) {
        clearInterval(intervalId);
        return;
      }
      try {
        await this.refreshDropletInfo();
      } catch (error) {
        console.log('Failed to get droplet info', error);
        this.setInstallState(InstallState.ERROR);
        clearInterval(intervalId);
        return;
      }
      updateInstallState();
      // Immediately clear the interval if the final install state has been
      // reached to prevent race conditions due to setInterval firing async.
      if (this.installState >= InstallState.SUCCESS) {
        clearInterval(intervalId);
        return;
      }
      // Note, if there is an error refreshing the droplet, we should just
      // try again, as there may be an intermittent network issue.
    }, 3000);
  }

  setProgressListener(listener: (progress: number) => void): void {
    this.listener = listener;
    listener(this.installProgress());
  }

  private setInstallState(installState: InstallState) {
    if (this.installState >= InstallState.SUCCESS) {
      // The install state is final and cannot be changed.
      return;
    }
    this.installState = installState;
    if (this.installState === InstallState.SUCCESS) {
      this.setInstallCompleted();
    }
    if (this.listener) {
      this.listener(this.installProgress());
    }
  }

  private installProgress(): number {
    // Installation typically takes 90 seconds in total.
    switch (this.installState) {
      case InstallState.UNKNOWN: return 0.1;
      case InstallState.CREATED: return 0.5;
      case InstallState.BOOTED: return 0.6;
      case InstallState.SUCCESS: return 1.0;
      default: return 0;
    }
  }

  // Returns true on success, else false.
  private setApiUrlAndCertificate(): boolean {
    try {
      // Attempt to get certificate fingerprint and management api address,
      // these methods throw exceptions if the fields are unavailable.
      const certificateFingerprint = this.getCertificateFingerprint();
      const apiAddress = this.getManagementApiAddress();
      // Loaded both the cert and url without exceptions, they can be set.
      trustCertificate(certificateFingerprint);
      this.setManagementApiUrl(apiAddress);
      return true;
    } catch (e) {
      // Install state not yet ready.
      return false;
    }
  }

  // Refreshes the state from DigitalOcean API.
  private async refreshDropletInfo(): Promise<void> {
    const newDropletInfo = await this.digitalOcean.getDroplet(this.dropletInfo.id);
    const oldDropletInfo = this.dropletInfo;
    this.dropletInfo = newDropletInfo;
    if (newDropletInfo.status !== oldDropletInfo.status) {
      if (newDropletInfo.status === 'active') {
        this.eventQueue.emit('server-active');
      }
    }
  }

  // Gets the key-value map stored in the DigitalOcean tags.
  private getTagMap(): {[key: string]: string} {
    const ret: {[key: string]: string} = {};
    const keyValuePrefix = KEY_VALUE_TAG + ':';
    for (const tag of this.dropletInfo.tags) {
      if (!startsWithCaseInsensitive(tag, keyValuePrefix)) {
        continue;
      }
      const keyValuePair = tag.slice(keyValuePrefix.length);
      const [key, hexValue] = keyValuePair.split(':', 2);
      try {
        ret[key.toLowerCase()] = hexToString(hexValue);
      } catch (e) {
        console.error('error decoding hex string');
      }
    }
    return ret;
  }

  // Returns the public ipv4 address of this server.
  private ipv4Address() {
    for (const network of this.dropletInfo.networks.v4) {
      if (network.type === 'public') {
        return network.ip_address;
      }
    }
    return undefined;
  }

  // Gets the address for the user management api, throws an error if unavailable.
  private getManagementApiAddress(): string {
    const tagMap = this.getTagMap();
    let apiAddress = tagMap[API_URL_TAG];
    // Check the old tags for backward-compatibility.
    // TODO(fortuna): Delete this before we release v1.0
    if (!apiAddress) {
      const portNumber = tagMap[DEPRECATED_API_PORT_TAG];
      if (!portNumber) {
        throw new Error('Could not get API port number');
      }
      if (!this.ipv4Address()) {
        throw new Error('API hostname not set');
      }
      apiAddress = `https://${this.ipv4Address()}:${portNumber}/`;
      const apiPrefix = tagMap[DEPRECATED_API_PREFIX_TAG];
      if (apiPrefix) {
        apiAddress += apiPrefix + '/';
      }
    }
    if (!apiAddress.endsWith('/')) {
      apiAddress += '/';
    }
    return apiAddress;
  }

  // Gets the certificate fingerprint in base64 format, throws an error if
  // unavailable.
  private getCertificateFingerprint(): string {
    const fingerprint = this.getTagMap()[CERTIFICATE_FINGERPRINT_TAG];
    if (fingerprint) {
      return btoa(fingerprint);
    } else {
      throw new Error('certificate fingerprint unavailable');
    }
  }

  getHost(): DigitalOceanHost {
    // Construct a new DigitalOceanHost object, to be sure it has the latest
    // session and droplet info.
    return new DigitalOceanHost(this.digitalOcean, this.dropletInfo, this.onDelete.bind(this));
  }

  // Callback to be invoked once server is deleted.
  private onDelete() {
    this.setInstallState(InstallState.DELETED);
  }

  private getInstallCompletedStorageKey() {
    return `droplet-${this.dropletInfo.id}-install-completed`;
  }

  private setInstallCompleted() {
    localStorage.setItem(this.getInstallCompletedStorageKey(), 'true');
  }

  public isInstallCompleted(): boolean {
    return localStorage.getItem(this.getInstallCompletedStorageKey()) === 'true';
  }
}

class DigitalOceanHost implements server.ManagedServerHost {
  constructor(
      private digitalOcean: DigitalOceanSession, private dropletInfo: DropletInfo,
      private deleteCallback: Function) {}

  getMonthlyOutboundTransferLimit(): server.DataAmount {
    // Details on the bandwidth limits can be found at
    // https://www.digitalocean.com/community/tutorials/digitalocean-bandwidth-billing-faq
    return {terabytes: this.dropletInfo.size.transfer};
  }

  getMonthlyCost(): server.MonetaryCost {
    return {usd: this.dropletInfo.size.price_monthly};
  }

  getCloudLocation(): Region {
    return new Region(this.dropletInfo.region.slug);
  }

  delete(): Promise<void> {
    return this.digitalOcean.deleteDroplet(this.dropletInfo.id).then(() => {
      this.deleteCallback();
    });
  }
}

function startsWithCaseInsensitive(text: string, prefix: string) {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

import * as semver from 'semver';

import * as errors from '../infrastructure/errors';
import * as server from '../model/server';
import {Surveys} from '../model/survey';
import * as digitalocean_server from '../providers/digitalocean/digitalocean_server';

import {DisplayServer, DisplayServerRepository, makeDisplayServer} from './display_server';
import {AppRoot} from './ui_components/app-root';
import {DisplayAccessKey, DisplayDataAmount, ServerView} from './ui_components/outline-server-view';

const CHANGE_KEYS_PORT_VERSION = '1.0.0';
const DATA_LIMITS_VERSION = '1.1.0';
const CHANGE_HOSTNAME_VERSION = '1.2.0';

// Date by which the data limits feature experiment will be permanently added or removed.
export const DATA_LIMITS_AVAILABILITY_DATE = new Date('2020-06-02');
const MAX_ACCESS_KEY_DATA_LIMIT_BYTES = 50 * (10 ** 9);  // 50GB

export class ServerManagementApp {
  // private selectedServer: server.Server;

  constructor(
      private appRoot: AppRoot, private manualServerRepository: server.ManualServerRepository,
      private displayServerRepository: DisplayServerRepository, private surveys: Surveys) {
    // Server management events
    appRoot.addEventListener('ServerRenameRequested', (event: CustomEvent) => {
      this.renameServer(event.detail.newName);
    });
    appRoot.addEventListener('ChangePortForNewAccessKeysRequested', (event: CustomEvent) => {
      this.setPortForNewAccessKeys(event.detail.validatedInput, event.detail.ui);
    });
    appRoot.addEventListener('ChangeHostnameForAccessKeysRequested', (event: CustomEvent) => {
      this.setHostnameForAccessKeys(event.detail.validatedInput, event.detail.ui);
    });

    // Access key events
    appRoot.addEventListener('AddAccessKeyRequested', (event: CustomEvent) => {
      this.addAccessKey();
    });
    appRoot.addEventListener('RemoveAccessKeyRequested', (event: CustomEvent) => {
      this.removeAccessKey(event.detail.accessKeyId);
    });
    appRoot.addEventListener('RenameAccessKeyRequested', (event: CustomEvent) => {
      this.renameAccessKey(event.detail.accessKeyId, event.detail.newName, event.detail.entry);
    });

    // Metric events
    appRoot.addEventListener('EnableMetricsRequested', (event: CustomEvent) => {
      this.setMetricsEnabled(true);
    });
    appRoot.addEventListener('DisableMetricsRequested', (event: CustomEvent) => {
      this.setMetricsEnabled(false);
    });

    // Data limits feature events
    appRoot.addEventListener('SetAccessKeyDataLimitRequested', (event: CustomEvent) => {
      this.setAccessKeyDataLimit(
          ServerManagementApp.displayDataAmountToDataLimit(event.detail.limit));
    });
    appRoot.addEventListener('RemoveAccessKeyDataLimitRequested', (event: CustomEvent) => {
      this.removeAccessKeyDataLimit();
    });
  }

  // Show the server management screen. Assumes the server is healthy.
  public async showServer(selectedServer: server.Server, selectedDisplayServer: DisplayServer) {
    this.selectedServer = selectedServer;
    this.appRoot.selectedServer = selectedDisplayServer;
    this.displayServerRepository.storeLastDisplayedServerId(selectedDisplayServer.id);

    // Show view and initialize fields from selectedServer.
    const view = this.appRoot.getServerView(selectedDisplayServer.id);
    view.isServerReachable = true;
    view.serverId = selectedServer.getServerId();
    view.serverName = selectedServer.getName();
    view.serverHostname = selectedServer.getHostnameForAccessKeys();
    view.serverManagementApiUrl = selectedServer.getManagementApiUrl();
    view.serverPortForNewAccessKeys = selectedServer.getPortForNewAccessKeys();
    view.serverCreationDate =
        ServerManagementApp.localizeDate(selectedServer.getCreatedDate(), this.appRoot.language);
    view.serverVersion = selectedServer.getVersion();
    view.dataLimitsAvailabilityDate =
        ServerManagementApp.localizeDate(DATA_LIMITS_AVAILABILITY_DATE, this.appRoot.language);
    view.accessKeyDataLimit =
        ServerManagementApp.dataLimitToDisplayDataAmount(selectedServer.getAccessKeyDataLimit());
    view.isAccessKeyDataLimitEnabled = !!view.accessKeyDataLimit;

    const version = this.selectedServer.getVersion();
    if (version) {
      view.isAccessKeyPortEditable = semver.gte(version, CHANGE_KEYS_PORT_VERSION);
      view.supportsAccessKeyDataLimit = semver.gte(version, DATA_LIMITS_VERSION);
      view.isHostnameEditable = semver.gte(version, CHANGE_HOSTNAME_VERSION);
    }

    if (ServerManagementApp.isManagedServer(selectedServer)) {
      view.isServerManaged = true;
      const host = selectedServer.getHost();
      view.monthlyCost = host.getMonthlyCost().usd;
      view.monthlyOutboundTransferBytes =
          host.getMonthlyOutboundTransferLimit().terabytes * (10 ** 12);
      view.serverLocation = this.getLocalizedCityName(host.getRegionId());
    } else {
      view.isServerManaged = false;
    }

    view.metricsEnabled = selectedServer.getMetricsEnabled();
    this.appRoot.showServerView();
    this.showMetricsOptInWhenNeeded(selectedServer, view);

    // Load "My Connection" and other access keys.
    try {
      const serverAccessKeys = await selectedServer.listAccessKeys();
      view.accessKeyRows = serverAccessKeys.map(this.convertToUiAccessKey.bind(this));
      if (!view.accessKeyDataLimit) {
        view.accessKeyDataLimit = ServerManagementApp.dataLimitToDisplayDataAmount(
            await ServerManagementApp.computeDefaultAccessKeyDataLimit(
                selectedServer, serverAccessKeys));
      }
      // Show help bubbles once the page has rendered.
      setTimeout(() => {
        ServerManagementApp.showHelpBubblesOnce(view);
      }, 250);
    } catch (error) {
      console.error(`Failed to load access keys: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-keys-get'));
    }

    this.showTransferStats(selectedServer, view);
  }

  // Syncs the locally persisted server metadata for `server`. Creates a DisplayServer for `server`
  // if one is not found in storage. Updates the UI to show the DisplayServer.
  // While this method does not make any assumptions on whether the server is reachable, it does
  // assume that its management API URL is available.
  private async syncServerToDisplay(server: server.Server): Promise<DisplayServer> {
    // We key display servers by the server management API URL, which can be retrieved independently
    // of the server health.
    const displayServerId = server.getManagementApiUrl();
    let displayServer = this.displayServerRepository.findServer(displayServerId);
    if (!displayServer) {
      console.debug(`Could not find display server with ID ${displayServerId}`);
      displayServer = await makeDisplayServer(server);
      this.displayServerRepository.addServer(displayServer);
    } else {
      // We may need to update the stored display server if it was persisted when the server was not
      // healthy, or the server has been renamed.
      try {
        const remoteServerName = server.getName();
        if (displayServer.name !== remoteServerName) {
          displayServer.name = remoteServerName;
        }
      } catch (e) {
        // Ignore, we may not have the server config yet.
      }
      // Mark the server as synced.
      this.displayServerRepository.removeServer(displayServer);
      displayServer.isSynced = true;
      this.displayServerRepository.addServer(displayServer);
    }
    return displayServer;
  }

  private async renameServer(newName: string) {
    const view = this.appRoot.getServerView(this.appRoot.selectedServer.id);
    try {
      await this.selectedServer.setName(newName);
      view.serverName = newName;
      this.syncAndShowServer(this.selectedServer);
    } catch (error) {
      console.error(`Failed to rename server: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-server-rename'));
      const oldName = this.selectedServer.getName();
      view.serverName = oldName;
      // tslint:disable-next-line:no-any
      (view.$.serverSettings as any).serverName = oldName;
    }
  }

  private async setMetricsEnabled(metricsEnabled: boolean) {
    try {
      await this.selectedServer.setMetricsEnabled(metricsEnabled);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      // Change metricsEnabled property on polymer element to update display.
      this.appRoot.getServerView(this.appRoot.selectedServer.id).metricsEnabled = metricsEnabled;
    } catch (error) {
      console.error(`Failed to set metrics enabled: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-metrics'));
    }
  }

  private showMetricsOptInWhenNeeded(selectedServer: server.Server, serverView: ServerView) {
    const showMetricsOptInOnce = () => {
      // Sanity check to make sure the running server is still displayed, i.e.
      // it hasn't been deleted.
      if (this.selectedServer !== selectedServer) {
        return;
      }
      // Show the metrics opt in prompt if the server has not already opted in,
      // and if they haven't seen the prompt yet according to localStorage.
      const storageKey = selectedServer.getServerId() + '-prompted-for-metrics';
      if (!selectedServer.getMetricsEnabled() && !localStorage.getItem(storageKey)) {
        this.appRoot.showMetricsDialogForNewServer();
        localStorage.setItem(storageKey, 'true');
      }
    };

    // Calculate milliseconds passed since server creation.
    const createdDate = selectedServer.getCreatedDate();
    const now = new Date();
    const msSinceCreation = now.getTime() - createdDate.getTime();

    // Show metrics opt-in once ONE_DAY_IN_MS has passed since server creation.
    const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
    if (msSinceCreation >= ONE_DAY_IN_MS) {
      showMetricsOptInOnce();
    } else {
      setTimeout(showMetricsOptInOnce, ONE_DAY_IN_MS - msSinceCreation);
    }
  }

  private async refreshTransferStats(selectedServer: server.Server, serverView: ServerView) {
    try {
      const stats = await selectedServer.getDataUsage();
      let totalBytes = 0;
      // tslint:disable-next-line:forin
      for (const accessKeyId in stats.bytesTransferredByUserId) {
        totalBytes += stats.bytesTransferredByUserId[accessKeyId];
      }
      serverView.setServerTransferredData(totalBytes);

      const accessKeyDataLimit = selectedServer.getAccessKeyDataLimit();
      if (accessKeyDataLimit) {
        // Make access key data usage relative to the data limit.
        totalBytes = accessKeyDataLimit.bytes;
      }

      // Update all the displayed access keys, even if usage didn't change, in case the data limit
      // did.
      for (const accessKey of serverView.accessKeyRows) {
        const accessKeyId = accessKey.id;
        const transferredBytes = stats.bytesTransferredByUserId[accessKeyId] || 0;
        let relativeTraffic =
            totalBytes ? 100 * transferredBytes / totalBytes : (accessKeyDataLimit ? 100 : 0);
        if (relativeTraffic > 100) {
          // Can happen when a data limit is set on an access key that already exceeds it.
          relativeTraffic = 100;
        }
        serverView.updateAccessKeyRow(accessKeyId, {transferredBytes, relativeTraffic});
      }
    } catch (e) {
      // Since failures are invisible to users we generally want exceptions here to bubble
      // up and trigger a Sentry report. The exception is network errors, about which we can't
      // do much (note: ShadowboxServer generates a breadcrumb for failures regardless which
      // will show up when someone explicitly submits feedback).
      if (e instanceof errors.ServerApiError && e.isNetworkError()) {
        return;
      }
      throw e;
    }
  }

  private showTransferStats(selectedServer: server.Server, serverView: ServerView) {
    this.refreshTransferStats(selectedServer, serverView);
    // Get transfer stats once per minute for as long as server is selected.
    const statsRefreshRateMs = 60 * 1000;
    const intervalId = setInterval(() => {
      if (this.selectedServer !== selectedServer) {
        // Server is no longer running, stop interval
        clearInterval(intervalId);
        return;
      }
      this.refreshTransferStats(selectedServer, serverView);
    }, statsRefreshRateMs);
  }

  // Converts the access key from the remote service format to the
  // format used by outline-server-view.
  private convertToUiAccessKey(remoteAccessKey: server.AccessKey): DisplayAccessKey {
    return {
      id: remoteAccessKey.id,
      placeholderName: `${this.appRoot.localize('key', 'keyId', remoteAccessKey.id)}`,
      name: remoteAccessKey.name,
      accessUrl: remoteAccessKey.accessUrl,
      transferredBytes: 0,
      relativeTraffic: 0
    };
  }

  // Access key methods
  private addAccessKey() {
    this.selectedServer.addAccessKey()
        .then((serverAccessKey: server.AccessKey) => {
          const uiAccessKey = this.convertToUiAccessKey(serverAccessKey);
          this.appRoot.getServerView(this.appRoot.selectedServer.id).addAccessKey(uiAccessKey);
          this.appRoot.showNotification(this.appRoot.localize('notification-key-added'));
        })
        .catch((error) => {
          console.error(`Failed to add access key: ${error}`);
          this.appRoot.showError(this.appRoot.localize('error-key-add'));
        });
  }

  private renameAccessKey(accessKeyId: string, newName: string, entry: polymer.Base) {
    this.selectedServer.renameAccessKey(accessKeyId, newName)
        .then(() => {
          entry.commitName();
        })
        .catch((error) => {
          console.error(`Failed to rename access key: ${error}`);
          this.appRoot.showError(this.appRoot.localize('error-key-rename'));
          entry.revertName();
        });
  }

  private removeAccessKey(accessKeyId: string) {
    this.selectedServer.removeAccessKey(accessKeyId)
        .then(() => {
          this.appRoot.getServerView(this.appRoot.selectedServer.id).removeAccessKey(accessKeyId);
          this.appRoot.showNotification(this.appRoot.localize('notification-key-removed'));
        })
        .catch((error) => {
          console.error(`Failed to remove access key: ${error}`);
          this.appRoot.showError(this.appRoot.localize('error-key-remove'));
        });
  }

  private async setAccessKeyDataLimit(limit: server.DataLimit) {
    if (!limit) {
      return;
    }
    const previousLimit = this.selectedServer.getAccessKeyDataLimit();
    if (previousLimit && limit.bytes === previousLimit.bytes) {
      return;
    }
    const serverView = this.appRoot.getServerView(this.appRoot.selectedServer.id);
    try {
      await this.selectedServer.setAccessKeyDataLimit(limit);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      serverView.accessKeyDataLimit = ServerManagementApp.dataLimitToDisplayDataAmount(limit);
      this.refreshTransferStats(this.selectedServer, serverView);
      this.surveys.presentDataLimitsEnabledSurvey();
    } catch (error) {
      console.error(`Failed to set access key data limit: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-set-data-limit'));
      serverView.accessKeyDataLimit = ServerManagementApp.dataLimitToDisplayDataAmount(
          previousLimit ||
          await ServerManagementApp.computeDefaultAccessKeyDataLimit(this.selectedServer));
      serverView.isAccessKeyDataLimitEnabled = !!previousLimit;
    }
  }

  private async removeAccessKeyDataLimit() {
    const serverView = this.appRoot.getServerView(this.appRoot.selectedServer.id);
    try {
      await this.selectedServer.removeAccessKeyDataLimit();
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      this.refreshTransferStats(this.selectedServer, serverView);
      this.surveys.presentDataLimitsDisabledSurvey();
    } catch (error) {
      console.error(`Failed to remove access key data limit: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-remove-data-limit'));
      serverView.isAccessKeyDataLimitEnabled = true;
    }
  }

  private async setHostnameForAccessKeys(hostname: string, serverSettings: polymer.Base) {
    this.appRoot.showNotification(this.appRoot.localize('saving'));
    try {
      await this.selectedServer.setHostnameForAccessKeys(hostname);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      serverSettings.enterSavedState();
    } catch (error) {
      this.appRoot.showError(this.appRoot.localize('error-not-saved'));
      if (error.isNetworkError()) {
        serverSettings.enterErrorState(this.appRoot.localize('error-network'));
        return;
      }
      const message = error.response.status === 400 ? 'error-hostname-invalid' : 'error-unexpected';
      serverSettings.enterErrorState(this.appRoot.localize(message));
    }
  }

  private async setPortForNewAccessKeys(port: number, serverSettings: polymer.Base) {
    this.appRoot.showNotification(this.appRoot.localize('saving'));
    try {
      await this.selectedServer.setPortForNewAccessKeys(port);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      serverSettings.enterSavedState();
    } catch (error) {
      this.appRoot.showError(this.appRoot.localize('error-not-saved'));
      if (error.isNetworkError()) {
        serverSettings.enterErrorState(this.appRoot.localize('error-network'));
        return;
      }
      const code = error.response.status;
      if (code === 409) {
        serverSettings.enterErrorState(this.appRoot.localize('error-keys-port-in-use'));
        return;
      }
      serverSettings.enterErrorState(this.appRoot.localize('error-unexpected'));
    }
  }

  private static localizeDate(date: Date, language: string): string {
    return date.toLocaleString(language, {year: 'numeric', month: 'long', day: 'numeric'});
  }

  private static async showHelpBubblesOnce(serverView: ServerView) {
    if (!window.localStorage.getItem('addAccessKeyHelpBubble-dismissed')) {
      await serverView.showAddAccessKeyHelpBubble();
      window.localStorage.setItem('addAccessKeyHelpBubble-dismissed', 'true');
    }
    if (!window.localStorage.getItem('getConnectedHelpBubble-dismissed')) {
      await serverView.showGetConnectedHelpBubble();
      window.localStorage.setItem('getConnectedHelpBubble-dismissed', 'true');
    }
    if (!window.localStorage.getItem('dataLimitsHelpBubble-dismissed') &&
        serverView.supportsAccessKeyDataLimit) {
      await serverView.showDataLimitsHelpBubble();
      window.localStorage.setItem('dataLimitsHelpBubble-dismissed', 'true');
    }
  }

  private static dataLimitToDisplayDataAmount(limit: server.DataLimit): DisplayDataAmount|null {
    if (!limit) {
      return null;
    }
    const bytes = limit.bytes;
    if (bytes >= 10 ** 9) {
      return {value: Math.floor(bytes / (10 ** 9)), unit: 'GB'};
    }
    return {value: Math.floor(bytes / (10 ** 6)), unit: 'MB'};
  }

  // Compute the suggested data limit based on the server's transfer capacity and number of access
  // keys.
  private static async computeDefaultAccessKeyDataLimit(
      server: server.Server, accessKeys?: server.AccessKey[]): Promise<server.DataLimit> {
    try {
      // Assume non-managed servers have a data transfer capacity of 1TB.
      let serverTransferCapacity: server.DataAmount = {terabytes: 1};
      if (ServerManagementApp.isManagedServer(server)) {
        serverTransferCapacity = server.getHost().getMonthlyOutboundTransferLimit();
      }
      if (!accessKeys) {
        accessKeys = await server.listAccessKeys();
      }
      let dataLimitBytes = serverTransferCapacity.terabytes * (10 ** 12) / (accessKeys.length || 1);
      if (dataLimitBytes > MAX_ACCESS_KEY_DATA_LIMIT_BYTES) {
        dataLimitBytes = MAX_ACCESS_KEY_DATA_LIMIT_BYTES;
      }
      return {bytes: dataLimitBytes};
    } catch (e) {
      console.error(`Failed to compute default access key data limit: ${e}`);
      return {bytes: MAX_ACCESS_KEY_DATA_LIMIT_BYTES};
    }
  }

  // TODO: Reconcile with copy in app.ts
  private static isManagedServer(testServer: server.Server): testServer is server.ManagedServer {
    return !!(testServer as server.ManagedServer).getHost;
  }

  // TODO: Reconcile with copy in app.ts
  private getLocalizedCityName(regionId: server.RegionId) {
    const cityId = digitalocean_server.GetCityId(regionId);
    return this.appRoot.localize(`city-${cityId}`);
  }

  private static displayDataAmountToDataLimit(dataAmount: DisplayDataAmount): server.DataLimit
      |null {
    if (!dataAmount) {
      return null;
    }
    if (dataAmount.unit === 'GB') {
      return {bytes: dataAmount.value * (10 ** 9)};
    } else if (dataAmount.unit === 'MB') {
      return {bytes: dataAmount.value * (10 ** 6)};
    }
    return {bytes: dataAmount.value};
  }
}

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

import {KeyValueStorage} from '../infrastructure/key_value_storage';
import {CloudProviderId} from '../model/cloud';
import {ManagedServerRepository} from '../model/server';
import {DigitalOceanServerRepositoryFactory, DigitalOceanSessionFactory} from './app';

export interface PersistedAccount {
  cloudProviderId: CloudProviderId;
  account: object;
}

export class AccountRepository {
  constructor(
      private storage: KeyValueStorage<PersistedAccount, string>,
      private digitalOceanAccountPersistence: DigitalOceanAccountPersistence) {}

  async connectDigitalOceanAccount(accessToken: string): Promise<void> {
    const persistedDigitalOceanAccount =
        await this.digitalOceanAccountPersistence.save(accessToken);
    const persistedAccount = {
      cloudProviderId: CloudProviderId.DigitalOcean,
      account: persistedDigitalOceanAccount,
    };
    this.storage.set(persistedAccount);
  }

  getDigitalOceanAccount(): ManagedServerRepository|undefined {
    const persistedAccount = this.storage.get(CloudProviderId.DigitalOcean);
    if (persistedAccount) {
      return this.digitalOceanAccountPersistence.load(persistedAccount.account);
    }
  }
}

interface PersistedDigitalOceanAccount {
  id: string;
  accessToken: string;
}

export class DigitalOceanAccountPersistence {
  constructor(
      private createDigitalOceanSession: DigitalOceanSessionFactory,
      private createDigitalOceanServerRepository: DigitalOceanServerRepositoryFactory) {}

  load(persistedAccount: object): ManagedServerRepository {
    const digitalOceanAccount = persistedAccount as PersistedDigitalOceanAccount;
    const session = this.createDigitalOceanSession(digitalOceanAccount.accessToken);
    return this.createDigitalOceanServerRepository(session);
  }

  async save(accessToken: string): Promise<PersistedDigitalOceanAccount> {
    const managedServerRepository = this.createManagedServerRepository(accessToken);
    const account = await managedServerRepository.getAccount();
    return {
      id: account.email,
      accessToken,
    };
  }

  private createManagedServerRepository(accessToken: string): ManagedServerRepository {
    const session = this.createDigitalOceanSession(accessToken);
    return this.createDigitalOceanServerRepository(session);
  }
}

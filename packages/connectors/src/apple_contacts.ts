/**
 * Apple Contacts Connector (V1 runtime)
 *
 * Phone-bridged: Address Book data is read via the Contacts framework on
 * iOS. The Lobu iOS Bridge claims runs advertising the `contacts` capability.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY =
  'Apple Contacts runs only on a worker advertising capability "contacts" (the Lobu iOS Bridge).';

export default class AppleContactsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.contacts',
    name: 'Apple Contacts',
    description:
      'Sync contacts from the Lobu iOS Bridge app. The iPhone reads the Contacts framework locally and streams entries to Lobu through the worker protocol.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'contacts',
    runtime: { platforms: ['ios'] },
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      contacts: {
        key: 'contacts',
        name: 'Contacts',
        description: 'Address-book entries with primary email, phone, and organization.',
        configSchema: {
          type: 'object',
          properties: {
            include_no_name: {
              type: 'boolean',
              default: false,
              description: 'Whether to include entries that have neither a given nor family name.',
            },
          },
        },
        eventKinds: {
          contact: {
            description: 'A single address-book entry.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'apple_contacts' },
                origin_id: { type: 'string' },
                full_name: { type: ['string', 'null'] },
                given_name: { type: ['string', 'null'] },
                family_name: { type: ['string', 'null'] },
                organization: { type: ['string', 'null'] },
                primary_email: { type: ['string', 'null'] },
                primary_phone: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY);
  }

  async execute(_a: string, _i: unknown, _c: ActionContext): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY);
  }
}

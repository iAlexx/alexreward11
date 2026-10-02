import { describe, expect, it } from 'vitest';

import { resolveAcceptedTonNetwork } from '../src/network.js';
import { WalletDomainError } from '../src/errors.js';

function mockClient(row: {
  id?: string;
  code: string;
  chain: string;
  environment: string;
  global_chain_identifier: string;
  status?: string;
}) {
  return {
    async query() {
      return {
        rows: [
          {
            id: row.id ?? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            code: row.code,
            chain: row.chain,
            environment: row.environment,
            global_chain_identifier: row.global_chain_identifier,
            status: row.status ?? 'ACTIVE',
          },
        ],
      };
    },
  } as never;
}

describe('phase21 resolveAcceptedTonNetwork environment matrix', () => {
  it('STAGING + MAINNET => reject ENVIRONMENT_MISMATCH', async () => {
    await expect(
      resolveAcceptedTonNetwork(
        mockClient({
          code: 'TON_MAINNET',
          chain: 'TON',
          environment: 'MAINNET',
          global_chain_identifier: 'ton:mainnet',
        }),
        {
          acceptedNetworkCode: 'TON_MAINNET',
          deploymentEnvironment: 'STAGING',
        },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_NETWORK',
      details: { reason: 'ENVIRONMENT_MISMATCH' },
    });
  });

  it('PRODUCTION + MAINNET => accept', async () => {
    const accepted = await resolveAcceptedTonNetwork(
      mockClient({
        code: 'TON_MAINNET',
        chain: 'TON',
        environment: 'MAINNET',
        global_chain_identifier: 'ton:mainnet',
      }),
      {
        acceptedNetworkCode: 'TON_MAINNET',
        deploymentEnvironment: 'PRODUCTION',
      },
    );
    expect(accepted.code).toBe('TON_MAINNET');
    expect(accepted.environment).toBe('MAINNET');
    expect(accepted.tonConnectNetworkId).toBe('-239');
  });

  it('PRODUCTION + TESTNET => reject ENVIRONMENT_MISMATCH', async () => {
    await expect(
      resolveAcceptedTonNetwork(
        mockClient({
          code: 'TON_TESTNET',
          chain: 'TON',
          environment: 'TESTNET',
          global_chain_identifier: 'ton:testnet',
        }),
        {
          acceptedNetworkCode: 'TON_TESTNET',
          deploymentEnvironment: 'PRODUCTION',
        },
      ),
    ).rejects.toBeInstanceOf(WalletDomainError);
    await expect(
      resolveAcceptedTonNetwork(
        mockClient({
          code: 'TON_TESTNET',
          chain: 'TON',
          environment: 'TESTNET',
          global_chain_identifier: 'ton:testnet',
        }),
        {
          acceptedNetworkCode: 'TON_TESTNET',
          deploymentEnvironment: 'PRODUCTION',
        },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_NETWORK',
      details: { reason: 'ENVIRONMENT_MISMATCH' },
    });
  });
});

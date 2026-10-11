import { describe, expect, it } from 'vitest';
import {
  buildTestWalletV5R1SignedExternalBoc,
  decodeWalletV5R1SignedExternal,
  deriveWalletV5R1AddressRaw,
  TON_MAINNET_NETWORK_GLOBAL_ID,
  TON_TESTNET_NETWORK_GLOBAL_ID,
} from '../src/index.js';

describe('Phase21 Wallet V5R1 signed external decoder network binding', () => {
  const pubkey = '11'.repeat(32);
  const destination = '0:' + '22'.repeat(32);
  it('decodes explicit Mainnet (-239) wallet request', async () => {
    const signed = await buildTestWalletV5R1SignedExternalBoc({
      publicKeyHex: pubkey,
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      seqno: 7,
      validUntil: 1950000000,
      toAddress: destination,
    });
    const decoded = decodeWalletV5R1SignedExternal(
      signed.signedWalletRequestBocBase64,
      TON_MAINNET_NETWORK_GLOBAL_ID
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.decoded.networkGlobalId).toBe(TON_MAINNET_NETWORK_GLOBAL_ID);
      expect(decoded.decoded.seqno).toBe(7);
      expect(decoded.decoded.signingMessageHashHex).toBe(signed.signingMessageHashHex);
    }
  });
  it('rejects unknown networks, independent of BOC validity', () => {
    const decoded = decodeWalletV5R1SignedExternal('eA==', -123);
    expect(decoded).toMatchObject({ok: false, code: 'NETWORK_UNSUPPORTED'});
  });
  it('does not change the Testnet-only fake provider gate', () => {
    expect(TON_TESTNET_NETWORK_GLOBAL_ID).toBe(-3);
    expect(deriveWalletV5R1AddressRaw({
      publicKeyHex: pubkey,
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID
    })).not.toBe(deriveWalletV5R1AddressRaw({
      publicKeyHex: pubkey,
      networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID
    }));
  });
});

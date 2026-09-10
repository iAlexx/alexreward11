import { describe, expect, it } from 'vitest';

import { LocalEphemeralSignPort, publicKeyFingerprint } from '../src/index.js';
import { signVerify } from '@ton/crypto';

describe('Phase 9 local KMS adapter', () => {
  it('does not claim formal AWS compatibility', async () => {
    const port = new LocalEphemeralSignPort(Buffer.alloc(32, 13));
    const desc = await port.describe();
    expect(desc.keySpec).toBe('LOCAL_EPHEMERAL_ED25519');
    const pk = await port.getPublicKey();
    expect(publicKeyFingerprint(pk)).toHaveLength(64);
    const msg = Buffer.alloc(32, 2);
    const sig = await port.signEd25519RawMessage(msg);
    expect(signVerify(msg, sig, pk)).toBe(true);
  });
});

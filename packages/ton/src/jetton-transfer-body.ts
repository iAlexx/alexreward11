/**
 * Minimal unsigned TEP-74 Jetton transfer body builder for Mainnet fee estimation.
 * Lives in @alex-rewards/ton so fee providers do not import @alex-rewards/signing
 * (signing already depends on ton — cycle unsafe).
 * Never signs. Never broadcasts.
 */
import { Address, beginCell, type Cell } from '@ton/core';

/** TEP-74 Jetton transfer op code. */
export const JETTON_TRANSFER_OP = 0xf8a7ea5;

/**
 * Candidate attached GRAM used ONLY to construct an unsigned estimateFee body.
 * NOT Owner-approved Mainnet attached policy. NOT a live payout value.
 * Documented Phase 21 Step 3C placeholder for fee emulation body shape.
 */
export const PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC = 50_000_000n;

export interface UnsignedJettonTransferBodyInput {
  readonly queryId: bigint;
  readonly netAmountAtomic: bigint;
  readonly destinationAddress: string;
  readonly responseDestinationAddress: string;
  readonly forwardTonAtomic: bigint;
}

/**
 * Build unsigned Jetton transfer body (TEP-74) for estimateFee / readiness only.
 */
export function buildUnsignedJettonTransferBody(input: UnsignedJettonTransferBodyInput): Cell {
  const destination = Address.parse(input.destinationAddress);
  const responseDestination = Address.parse(input.responseDestinationAddress);
  return beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(input.queryId, 64)
    .storeCoins(input.netAmountAtomic)
    .storeAddress(destination)
    .storeAddress(responseDestination)
    .storeBit(0) // no custom payload
    .storeCoins(input.forwardTonAtomic)
    .storeBit(0) // no forward payload
    .endCell();
}

export function buildUnsignedJettonTransferBodyBase64(
  input: UnsignedJettonTransferBodyInput,
): string {
  return buildUnsignedJettonTransferBody(input).toBoc().toString('base64');
}

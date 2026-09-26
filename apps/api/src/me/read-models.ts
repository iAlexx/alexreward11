import type { DomainEnvelope, DomainReasonCode } from '@alex-rewards/contracts';

export function readyDomain<TData>(data: TData): DomainEnvelope<TData> {
  return { status: 'READY', data };
}

export function emptyDomain<TData>(errorCode: DomainReasonCode = 'NO_DATA'): DomainEnvelope<TData> {
  return { status: 'EMPTY', data: null, errorCode };
}

export function unavailableDomain<TData>(errorCode: DomainReasonCode): DomainEnvelope<TData> {
  return { status: 'UNAVAILABLE', data: null, errorCode };
}

/**
 * Resolve one home-screen domain into its own envelope.
 *
 * Failure is contained: a domain that throws becomes `UNAVAILABLE`/`READ_FAILED` and the
 * rest of the response still answers truthfully. A read that legitimately finds nothing
 * returns `null` and becomes `EMPTY` — which is a different statement from "we could not
 * read this", and the client must be able to tell the two apart.
 */
export async function settleDomain<TData>(
  read: () => Promise<TData | null>,
): Promise<DomainEnvelope<TData>> {
  try {
    const data = await read();
    return data === null ? emptyDomain<TData>() : readyDomain(data);
  } catch {
    // The underlying error is logged by the framework; the client gets no internal detail.
    return unavailableDomain<TData>('READ_FAILED');
  }
}

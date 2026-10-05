'use client';

import { use } from 'react';

import { WithdrawalDetailScreen } from '../../../../../components/WithdrawalDetailScreen';

export default function WithdrawalDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = use(params);
  return <WithdrawalDetailScreen id={id} />;
}

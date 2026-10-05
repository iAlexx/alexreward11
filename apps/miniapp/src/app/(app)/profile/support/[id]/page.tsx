'use client';

import { use } from 'react';

import { SupportDetailScreen } from '../../../../../components/SupportDetailScreen';

export default function SupportDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = use(params);
  return <SupportDetailScreen id={id} />;
}

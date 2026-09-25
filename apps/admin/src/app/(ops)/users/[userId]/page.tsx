import { UserDetailPage } from '../../../../components/pages/UserDetailPage';

export default async function Page({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <UserDetailPage userId={userId} />;
}

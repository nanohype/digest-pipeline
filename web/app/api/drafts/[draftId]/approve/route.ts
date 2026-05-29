import { proxyRequest } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  return proxyRequest('POST', `/drafts/${draftId}/approve`);
}

import { proxyRequest } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  return proxyRequest('GET', `/drafts/${draftId}`);
}

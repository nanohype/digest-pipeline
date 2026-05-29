import { proxyRequest } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const body = (await req.json()) as unknown;
  return proxyRequest('POST', `/drafts/${draftId}/edits`, body);
}

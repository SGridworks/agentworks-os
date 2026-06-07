import { notFound, redirect } from 'next/navigation';
import { getIssue, type ExecutionIssue } from '@/lib/api';

export default async function IssueDetailRedirectPage({
  params,
}: {
  params: { issueId: string };
}) {
  let issue: ExecutionIssue;
  try {
    issue = await getIssue(params.issueId);
  } catch {
    notFound();
  }
  redirect(`/mission-control/${issue.companyId}/issues/${issue.id}/activity`);
}

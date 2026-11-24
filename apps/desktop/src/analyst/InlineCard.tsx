import type { Approval } from '@tessera/protocol';
import { cx } from '@tessera/ui';
import { useEffect, useState } from 'react';
import { approvalEnv } from '../shell/approval.ts';
import { ApprovalCard } from '../shell/ApprovalCard.tsx';
import { analystStore, markArrived } from './analystStore.ts';
import { InlineApproval } from './InlineApproval.tsx';
import { read } from '../app/store.ts';

export function InlineCard({ approval, sessionTitle }: { approval: Approval; sessionTitle: string | null }) {
  const [arriving] = useState(() => !read(analystStore).arrived.has(approval.id));
  useEffect(() => markArrived(approval.id), [approval.id]);
  return (
    <div
      className={cx('an-card', arriving && 'is-arriving')}
      data-approval={approval.id}
      data-env={approvalEnv(approval)}
    >
      {approval.kind === 'financial' ? (
        <ApprovalCard
          key={`${approval.id}:${approval.previewHash}`}
          approval={approval}
          more={0}
          sessionTitle={sessionTitle}
        />
      ) : (
        <InlineApproval key={`${approval.id}:${approval.previewHash}`} approval={approval} />
      )}
    </div>
  );
}

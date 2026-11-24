import { focusComposer } from '../shell/composer.ts';
import { workspaceContext } from '../workspace/controller.ts';
import { revealTile } from '../workspace/dock/open.ts';
import { analystStore } from './analystStore.ts';
import { focusApprovalCard } from './focus.ts';
import { read } from '../app/store.ts';

export function revealApproval(approvalId: string | null = null, via: 'pointer' | 'key' = 'pointer'): void {
  revealTile('analyst', { via });
  const pending = read(analystStore).approvals ?? [];
  const target = (approvalId ? pending.find((a) => a.id === approvalId) : null) ?? pending[0] ?? null;
  let tries = 0;
  const attempt = () => {
    const root = workspaceContext()?.api.getPanel('analyst')?.view.content.element ?? document;
    if (target && focusApprovalCard(root, target.id)) return;
    if (!target || ++tries > 20) {
      focusComposer();
      return;
    }
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

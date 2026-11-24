import { MenuSub, MenuSubContent, MenuSubTrigger } from '@tessera/ui';
import { LibraryItems } from '../workspace/dock/PanelsLibrary.tsx';

export function PanelsSub() {
  return (
    <MenuSub>
      <MenuSubTrigger>Panels</MenuSubTrigger>
      <MenuSubContent className="dock-library" style={{ width: 248 }} onFocusOutside={(e) => e.preventDefault()}>
        <LibraryItems into={null} />
      </MenuSubContent>
    </MenuSub>
  );
}

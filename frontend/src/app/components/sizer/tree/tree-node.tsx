/**
 * tree-node.tsx — Recursive TreeNode for Region/Country/City/Site.
 *
 * Per UI-SPEC §4.2 and CONTEXT D-07 / RESEARCH Pitfall 6:
 *   - Radix Collapsible handles only visual expand/collapse (Pitfall 6 says
 *     Radix does NOT emit tree/treeitem roles).
 *   - Tree ARIA attributes (`role="treeitem"`, `aria-level`, `aria-expanded`,
 *     `aria-selected`) are applied manually.
 *   - Keyboard handling (ArrowUp/Down/Right/Left, Home/End, Enter, Space,
 *     Delete) is owned by the tree CONTAINER in `sizer-step-regions.tsx`
 *     (single onKeyDown handler). This component just renders.
 */
import { Collapsible, CollapsibleContent } from '../../ui/collapsible';
import { ChevronRight } from 'lucide-react';

import { cn } from '../../ui/utils';

export type TreeLevel = 1 | 2 | 3 | 4;

const INDENT_CLASS: Record<TreeLevel, string> = {
  1: 'pl-2',
  2: 'pl-6',
  3: 'pl-10',
  4: 'pl-14',
};

export interface TreeNodeProps {
  id: string;
  level: TreeLevel;
  label: React.ReactNode;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  children?: React.ReactNode;
  isLeaf?: boolean;
  /** Optional trailing controls (e.g. delete icon). */
  rightSlot?: React.ReactNode;
}

export function TreeNode({
  id,
  level,
  label,
  expanded,
  selected,
  onToggle,
  onSelect,
  children,
  isLeaf,
  rightSlot,
}: TreeNodeProps) {
  return (
    <Collapsible open={expanded} onOpenChange={onToggle} asChild>
      <li
        role="treeitem"
        aria-level={level}
        aria-expanded={isLeaf ? undefined : expanded}
        aria-selected={selected}
        data-testid={`sizer-tree-node-${id}`}
        data-node-id={id}
        data-level={level}
      >
        <div
          onClick={onSelect}
          className={cn(
            'flex items-center gap-2 py-1 pr-2 rounded-sm',
            INDENT_CLASS[level],
            selected && 'bg-secondary',
          )}
        >
          {!isLeaf ? (
            <button
              type="button"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              data-testid={`sizer-tree-toggle-${id}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="inline-flex items-center justify-center size-4 rounded hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', expanded && 'rotate-90')}
                aria-hidden="true"
              />
            </button>
          ) : (
            <span className="inline-block size-4" aria-hidden="true" />
          )}
          <span className="flex-1 flex items-center gap-2 min-w-0">{label}</span>
          {rightSlot}
        </div>
        {!isLeaf && (
          <CollapsibleContent>
            <ul role="group" className="list-none m-0 p-0">
              {children}
            </ul>
          </CollapsibleContent>
        )}
      </li>
    </Collapsible>
  );
}

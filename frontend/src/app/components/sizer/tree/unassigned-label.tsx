/**
 * unassigned-label.tsx — Italic muted `(Unassigned)` placeholder with
 * rename-on-click.
 *
 * Per UI-SPEC §4.2 and CONTEXT D-08:
 *   - Rendered verbatim as UNASSIGNED_PLACEHOLDER constant.
 *   - Click converts label to an inline <Input>; Enter saves, Escape reverts.
 *   - If the node's actual name already differs from the placeholder, renders
 *     the real name in normal (non-italic) styling.
 */
import { useState } from 'react';

import { Input } from '../../ui/input';
import { cn } from '../../ui/utils';
import { UNASSIGNED_PLACEHOLDER } from '../sizer-types';
import { useSizer } from '../sizer-state';

interface UnassignedLabelProps {
  nodeKind: 'country' | 'city';
  nodeId: string;
  name: string;
}

export function UnassignedLabel({ nodeKind, nodeId, name }: UnassignedLabelProps) {
  const { dispatch } = useSizer();
  const isPlaceholder = name === UNASSIGNED_PLACEHOLDER;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) {
      if (nodeKind === 'country') {
        dispatch({ type: 'UPDATE_COUNTRY', countryId: nodeId, patch: { name: trimmed } });
      } else {
        dispatch({ type: 'UPDATE_CITY', cityId: nodeId, patch: { name: trimmed } });
      }
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className="h-6 py-0 px-1 text-sm w-48"
        data-testid={`sizer-unassigned-input-${nodeId}`}
        aria-label={`Rename ${nodeKind}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setDraft(name);
        setEditing(true);
      }}
      data-testid={`sizer-unassigned-label-${nodeId}`}
      className={cn(
        'text-left bg-transparent border-0 p-0 cursor-text',
        isPlaceholder && 'italic text-muted-foreground',
      )}
    >
      {name}
    </button>
  );
}

import { Trash2Icon } from "lucide-react";

import { Button } from "./ui/button";

/** A grouped row shows one checkout, but removal takes them all. */
export function projectRemoveAction(name: string, checkoutCount: number) {
  return checkoutCount === 1
    ? `Remove ${name}`
    : `Remove ${checkoutCount === 2 ? "both" : `all ${checkoutCount}`} checkouts of ${name}`;
}

/**
 * Remove button for a project row in a menu or list, shown only on the highlighted row.
 * Keyboard users get the remove shortcut from the list that hosts it, so the button stays
 * out of the tab order.
 */
export function ProjectRemoveButton(props: {
  readonly name: string;
  readonly checkoutCount: number;
  readonly onRemove: () => void;
  readonly shortcutLabel?: string | null;
}) {
  const action = projectRemoveAction(props.name, props.checkoutCount);
  return (
    <span className="flex opacity-0 in-data-highlighted:opacity-100 pointer-coarse:opacity-100">
      <Button
        size="icon-xs"
        variant="ghost-destructive"
        tabIndex={-1}
        aria-hidden="true"
        title={props.shortcutLabel ? `${action} (${props.shortcutLabel})` : action}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onRemove();
        }}
      >
        {/* The row tints every icon muted; this one follows the button so hover turns it red. */}
        <Trash2Icon className="size-3.5 text-current" />
      </Button>
    </span>
  );
}

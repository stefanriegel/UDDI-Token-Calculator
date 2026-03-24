---
name: add-ui-component
description: Creates a new React component following the project's Radix UI / shadcn pattern with Tailwind CSS and Infoblox theme variables. Uses cn() utility, cva variants, proper data-slot attributes. Use when user says 'add component', 'new UI element', 'create widget', or adds files to frontend/src/app/components/. Do NOT use for backend changes, Go code, or scanner implementations.
---
# Add UI Component

## Critical

- **All components go in `frontend/src/app/components/ui/`** — this is the only valid location for UI primitives (e.g., `button.tsx`, `card.tsx`, `badge.tsx`, `tooltip.tsx`).
- **Named exports only** — never use `export default`. Export the component and its variants (if any).
- **Every root and key sub-element MUST have `data-slot="component-name"`** — this is non-negotiable for CSS specificity and testing.
- **Import `cn` from `frontend/src/app/components/ui/utils.ts`** — use `"./utils"` when importing from within `ui/`, or `"@/app/components/ui/utils"` from outside.
- **Use Infoblox theme variables** from `frontend/src/styles/theme.css` — `bg-primary` (#002b49 navy), `bg-accent` (#f37021 orange), `bg-infoblox-blue` (#3a8fd6), `text-foreground`, `bg-background`, etc. Never hardcode hex colors.
- **CGO/backend not involved** — this skill is frontend-only.

## Instructions

### Step 1: Create the component file

Place the new file in `frontend/src/app/components/ui/` with a kebab-case filename (following existing files like `button.tsx`, `card.tsx`, `select.tsx`, `tooltip.tsx`).

Start with this template based on component complexity:

**Simple component (no variants):**
```tsx
import * as React from "react";
import { cn } from "./utils";

function ComponentName({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="component-name"
      className={cn(
        "base-tailwind-classes",
        className,
      )}
      {...props}
    />
  );
}

export { ComponentName };
```

**Component with variants (uses CVA):**
```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const componentNameVariants = cva(
  "base-classes shared-across-all-variants",
  {
    variants: {
      variant: {
        default: "variant-specific-classes",
      },
      size: {
        default: "size-specific-classes",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function ComponentName({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof componentNameVariants>) {
  return (
    <div
      data-slot="component-name"
      className={cn(componentNameVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { ComponentName, componentNameVariants };
```

**Radix UI wrapper:**
```tsx
"use client";

import * as React from "react";
import * as PrimitiveName from "@radix-ui/react-primitive-name";
import { cn } from "./utils";

function ComponentName({
  ...props
}: React.ComponentProps<typeof PrimitiveName.Root>) {
  return <PrimitiveName.Root data-slot="component-name" {...props} />;
}

function ComponentNameContent({
  className,
  ...props
}: React.ComponentProps<typeof PrimitiveName.Content>) {
  return (
    <PrimitiveName.Content
      data-slot="component-name-content"
      className={cn("styled-classes", className)}
      {...props}
    />
  );
}

export { ComponentName, ComponentNameContent };
```

Verify: File is in `frontend/src/app/components/ui/`, uses kebab-case filename, PascalCase component name.

### Step 2: Apply standard Tailwind patterns

Use these exact patterns from the codebase:

- **Focus visible:** `focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]`
- **Disabled:** `disabled:pointer-events-none disabled:opacity-50`
- **Validation:** `aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive`
- **SVG children:** `[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none`
- **Animations:** `data-[state=open]:animate-in data-[state=closed]:animate-out`

Verify: `className` is always the last argument to `cn()` so consumer overrides win.

### Step 3: Add composition sub-components (if needed)

For compound components (like `frontend/src/app/components/ui/card.tsx` → CardHeader, CardContent, CardFooter), create each sub-component as a separate function in the same file:

```tsx
function ComponentNameHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="component-name-header"
      className={cn("header-classes", className)}
      {...props}
    />
  );
}
```

Verify: Each sub-component has a unique `data-slot` value following `component-name-subpart` pattern.

### Step 4: Export and use

Export all components and variants at the bottom of the file:
```tsx
export { ComponentName, ComponentNameHeader, ComponentNameContent, componentNameVariants };
```

Import from consuming components:
```tsx
// From within frontend/src/app/components/
import { ComponentName, ComponentNameContent } from './ui/component-name';
// From elsewhere in frontend/src/
import { ComponentName } from '@/app/components/ui/component-name';
```

Verify: Run `cd frontend && pnpm build` to confirm no TypeScript errors.

### Step 5: Add icons (if needed)

Use `lucide-react` for all icons:
```tsx
import { XIcon, ChevronDownIcon } from "lucide-react";
```

Verify: Icon is from `lucide-react`, not from other icon packages.

## Examples

**User says:** "Add a StatusBadge component with success, warning, and error variants"

**Actions:**
1. Create `frontend/src/app/components/ui/status-badge.tsx`
2. Define `statusBadgeVariants` with CVA:
```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const statusBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        success: "bg-green-100 text-green-800",
        warning: "bg-yellow-100 text-yellow-800",
        error: "bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "success",
    },
  },
);

function StatusBadge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusBadgeVariants>) {
  return (
    <span
      data-slot="status-badge"
      className={cn(statusBadgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { StatusBadge, statusBadgeVariants };
```
3. Run `cd frontend && pnpm build` — passes.

## Common Issues

**`cn` import not found:**
The utility is at `frontend/src/app/components/ui/utils.ts`, not `@/lib/utils`. Use `import { cn } from "./utils"` when importing from within the `frontend/src/app/components/ui/` directory.

**`Module not found: @radix-ui/react-*`:**
Install the Radix primitive first: `cd frontend && pnpm add @radix-ui/react-{primitive-name}`

**Tailwind classes not applying:**
This project uses Tailwind CSS 4 with `@tailwindcss/vite` plugin and `@theme inline` in `frontend/src/styles/theme.css`. Custom colors are mapped via CSS variables (e.g., `--color-primary: var(--primary)`). Use semantic names like `bg-primary`, `text-accent`, `bg-infoblox-blue` — not raw values.

**TypeScript error on Radix wrapper props:**
Use `React.ComponentProps<typeof PrimitiveName.SubComponent>` — not `React.HTMLAttributes<HTMLElement>`. The Radix type includes all primitive-specific props.

**Component not rendering theme colors:**
Ensure `frontend/src/styles/theme.css` is imported in the app entry. It's loaded via `frontend/src/main.tsx`. If adding new CSS variables, add them to both `:root` and the `@theme inline` block in `frontend/src/styles/theme.css`.

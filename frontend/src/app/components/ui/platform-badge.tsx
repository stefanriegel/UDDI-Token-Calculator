import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

const platformBadgeVariants = cva(
  "inline-block px-2 py-0.5 rounded text-[10px] text-white",
  {
    variants: {
      platform: {
        Physical: "bg-gray-500",
        VMware: "bg-blue-600",
        AWS: "bg-orange-500",
        Azure: "bg-sky-600",
        GCP: "bg-green-600",
        KVM: "bg-violet-500",
        "Hyper-V": "bg-indigo-500",
      },
    },
    defaultVariants: {
      platform: "Physical",
    },
  },
);

function PlatformBadge({
  className,
  platform,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof platformBadgeVariants>) {
  return (
    <span
      data-slot="platform-badge"
      style={{ fontWeight: 600 }}
      className={cn(platformBadgeVariants({ platform }), className)}
      {...props}
    />
  );
}

export { PlatformBadge, platformBadgeVariants };

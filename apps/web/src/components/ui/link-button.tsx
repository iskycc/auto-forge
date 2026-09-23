"use client";

import { Button } from "antd";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

type LinkButtonProps = Omit<ComponentProps<typeof Button>, "href" | "type" | "variant"> & {
  href: string;
  variant?: "default" | "primary";
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
};

/** Ant Design anchor button with the same client navigation and modifier keys as Next Link. */
export function LinkButton({
  href,
  variant = "default",
  prefetch,
  replace = false,
  scroll = true,
  onClick,
  onMouseEnter,
  ...props
}: LinkButtonProps) {
  const router = useRouter();
  const internal = href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/");
  return (
    <Button
      {...props}
      href={href}
      type={variant}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (internal && prefetch !== false) router.prefetch(href);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          !internal ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (props.target && props.target !== "_self") ||
          props.download
        )
          return;
        event.preventDefault();
        if (replace) router.replace(href, { scroll });
        else router.push(href, { scroll });
      }}
    />
  );
}

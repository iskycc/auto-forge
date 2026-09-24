import { Alert } from "antd";
import type { ComponentProps } from "react";
import { definedProps } from "@/lib/utils";

export function Notice({
  children,
  tone = "info",
  role,
  ...props
}: Omit<ComponentProps<"div">, "ref"> & {
  tone?: "error" | "warning" | "info" | "success";
  showIcon?: boolean;
}) {
  return (
    <Alert
      {...definedProps(props)}
      type={tone}
      title={children}
      role={role ?? (tone === "error" ? "alert" : "note")}
    />
  );
}

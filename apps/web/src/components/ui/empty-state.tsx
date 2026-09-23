import { Empty } from "antd";
import type { ComponentProps } from "react";
import { definedProps } from "@/lib/utils";

/** Keep each screen's explanatory text and actions inside Ant Design's empty state. */
export function EmptyState({ children, ...props }: Omit<ComponentProps<"div">, "ref">) {
  return (
    <Empty
      {...definedProps(props)}
      image={null}
      description={children}
      classNames={{ description: "contents" }}
      styles={{ image: { display: "none" } }}
    />
  );
}

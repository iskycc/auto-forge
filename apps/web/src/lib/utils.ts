import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** React native props allow explicit undefined; Ant Design uses exact optional props. */
export function definedProps<T extends object>(
  props: T,
): {
  [Key in keyof T]: Exclude<T[Key], undefined>;
} {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as {
    [Key in keyof T]: Exclude<T[Key], undefined>;
  };
}
